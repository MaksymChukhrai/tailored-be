import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Share, ShareMode, ShareRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DataRoomsService } from '../data-rooms/data-rooms.service';
import type { DataRoomRootContents } from '../data-rooms/data-rooms.service';
import { FoldersService } from '../folders/folders.service';
import type { FolderContents } from '../folders/folders.service';
import { FilesService } from '../files/files.service';

export interface ShareTarget {
  type: 'dataRoom' | 'folder' | 'file';
  id: string;
  ownerId: string;
}

export type ResolvedShareContent =
  | { type: 'dataRoom'; rootContents: DataRoomRootContents }
  | { type: 'folder'; contents: FolderContents }
  | { type: 'file'; downloadUrl: string };

export interface ResolvedShare {
  share: Share;
  target: ShareTarget;
  content: ResolvedShareContent;
}

@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

   public constructor(
    private readonly prisma: PrismaService,
    private readonly dataRoomsService: DataRoomsService,
    private readonly foldersService: FoldersService,
    private readonly filesService: FilesService,
  ) {}

  public async create(
    userId: string,
    params: {
      mode: ShareMode;
      dataRoomId?: string;
      folderId?: string;
      fileId?: string;
    },
  ): Promise<Share> {
    const targets = [params.dataRoomId, params.folderId, params.fileId].filter(Boolean);
    if (targets.length !== 1) {
      throw new BadRequestException(
        'Exactly one of dataRoomId, folderId, or fileId must be provided',
      );
    }

    const target = await this.resolveAndAssertOwner(userId, params);

    try {
      return await this.prisma.share.create({
        data: {
          mode: params.mode,
          role: ShareRole.VIEWER,
          token: this.generateToken(),
          grantedById: userId,
          dataRoomId: target.type === 'dataRoom' ? target.id : undefined,
          folderId: target.type === 'folder' ? target.id : undefined,
          fileId: target.type === 'file' ? target.id : undefined,
        },
      });
    } catch (error: unknown) {
      this.logger.error('Failed to create share', error);
      throw error;
    }
  }

  public async addGrantee(shareId: string, userId: string, email: string): Promise<void> {
    const share = await this.findByIdOrThrow(shareId);
    await this.assertGrantor(share, userId);

    if (share.mode !== ShareMode.PERMISSIONED) {
      throw new BadRequestException('Cannot add grantees to a public-link share');
    }

    const grantee = await this.prisma.user.findUnique({ where: { email } });
    if (!grantee) {
      throw new NotFoundException(
        `No user found with email "${email}". They must sign in at least once before being granted access.`,
      );
    }

    try {
      await this.prisma.shareGrantee.upsert({
        where: { shareId_userId: { shareId, userId: grantee.id } },
        create: { shareId, userId: grantee.id },
        update: {},
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to add grantee ${email} to share ${shareId}`, error);
      throw error;
    }
  }

  public async removeGrantee(shareId: string, userId: string, granteeUserId: string): Promise<void> {
    const share = await this.findByIdOrThrow(shareId);
    await this.assertGrantor(share, userId);

    try {
      await this.prisma.shareGrantee.deleteMany({
        where: { shareId, userId: granteeUserId },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to remove grantee from share ${shareId}`, error);
      throw error;
    }
  }

  public async revoke(shareId: string, userId: string): Promise<void> {
    const share = await this.findByIdOrThrow(shareId);
    await this.assertGrantor(share, userId);

    try {
      await this.prisma.share.update({
        where: { id: shareId },
        data: { revokedAt: new Date() },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to revoke share ${shareId}`, error);
      throw error;
    }
  }

  public async listForTarget(
    userId: string,
    params: { dataRoomId?: string; folderId?: string; fileId?: string },
  ): Promise<Share[]> {
    await this.resolveAndAssertOwner(userId, params);

    try {
      return await this.prisma.share.findMany({
        where: {
          dataRoomId: params.dataRoomId,
          folderId: params.folderId,
          fileId: params.fileId,
          revokedAt: null,
        },
        include: { grantees: { include: { user: true } } },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error: unknown) {
      this.logger.error('Failed to list shares for target', error);
      throw error;
    }
  }

  /**
   * Resolves a share by its public token and verifies the requester may
   * view it: PUBLIC_LINK shares are open to anyone with the link;
   * PERMISSIONED shares require the requester to be an authenticated
   * grantee. Also logs the access for the audit trail.
   */
  public async resolveByToken(token: string, viewerUserId?: string): Promise<ResolvedShare> {
    const share = await this.prisma.share.findUnique({
      where: { token },
      include: { grantees: true },
    });

    if (!share || share.revokedAt) {
      throw new NotFoundException('This share link is invalid or has been revoked');
    }

    if (share.mode === ShareMode.PERMISSIONED) {
      const isGrantee = viewerUserId
        ? share.grantees.some((g) => g.userId === viewerUserId)
        : false;
      if (!isGrantee) {
        throw new ForbiddenException(
          'You do not have permission to view this shared item',
        );
      }
    }

    const target = this.identifyTarget(share);
    const content = await this.loadContent(target, viewerUserId);

    try {
      await this.prisma.shareAccessLog.create({
        data: { shareId: share.id, userId: viewerUserId ?? null },
      });
    } catch (error: unknown) {
      // Access logging failure should never block the actual view.
      this.logger.error(`Failed to log access for share ${share.id}`, error);
    }

    return { share, target, content };
  }

  /**
   * Loads the actual viewable payload for the resolved target. Delegates
   * to the same read methods used by authenticated owners — those already
   * enforce access via AccessControlService, which recognizes this very
   * share as a valid access grant, so no duplicate authorization logic
   * is needed here.
   */
  private async loadContent(
    target: ShareTarget,
    viewerUserId?: string,
  ): Promise<ResolvedShareContent> {
    try {
      if (target.type === 'dataRoom') {
        const rootContents = await this.dataRoomsService.getRootContents(
          target.id,
          viewerUserId,
        );
        return { type: 'dataRoom', rootContents };
      }

      if (target.type === 'folder') {
        const contents = await this.foldersService.getContents(target.id, viewerUserId);
        return { type: 'folder', contents };
      }

      const downloadUrl = await this.filesService.getDownloadUrl(target.id, viewerUserId);
      return { type: 'file', downloadUrl };
    } catch (error: unknown) {
      this.logger.error(`Failed to load content for shared ${target.type} ${target.id}`, error);
      throw error;
    }
  }

  private async findByIdOrThrow(id: string): Promise<Share> {
    const share = await this.prisma.share.findUnique({ where: { id } });
    if (!share) {
      throw new NotFoundException('Share not found');
    }
    return share;
  }

  private async assertGrantor(share: Share, userId: string): Promise<void> {
    if (share.grantedById !== userId) {
      throw new ForbiddenException('You do not have permission to manage this share');
    }
  }

  private async resolveAndAssertOwner(
    userId: string,
    params: { dataRoomId?: string; folderId?: string; fileId?: string },
  ): Promise<ShareTarget> {
    if (params.dataRoomId) {
      const dataRoom = await this.prisma.dataRoom.findUnique({
        where: { id: params.dataRoomId },
      });
      if (!dataRoom) {
        throw new NotFoundException('Data room not found');
      }
      if (dataRoom.ownerId !== userId) {
        throw new ForbiddenException('You do not own this data room');
      }
      return { type: 'dataRoom', id: dataRoom.id, ownerId: dataRoom.ownerId };
    }

    if (params.folderId) {
      const folder = await this.prisma.folder.findUnique({
        where: { id: params.folderId },
        include: { dataRoom: true },
      });
      if (!folder) {
        throw new NotFoundException('Folder not found');
      }
      if (folder.dataRoom.ownerId !== userId) {
        throw new ForbiddenException('You do not own this folder');
      }
      return { type: 'folder', id: folder.id, ownerId: folder.dataRoom.ownerId };
    }

    if (params.fileId) {
      const file = await this.prisma.file.findUnique({
        where: { id: params.fileId },
        include: { dataRoom: true },
      });
      if (!file) {
        throw new NotFoundException('File not found');
      }
      if (file.dataRoom.ownerId !== userId) {
        throw new ForbiddenException('You do not own this file');
      }
      return { type: 'file', id: file.id, ownerId: file.dataRoom.ownerId };
    }

    throw new BadRequestException(
      'Exactly one of dataRoomId, folderId, or fileId must be provided',
    );
  }

  private identifyTarget(share: Share): ShareTarget {
    if (share.dataRoomId) {
      return { type: 'dataRoom', id: share.dataRoomId, ownerId: share.grantedById };
    }
    if (share.folderId) {
      return { type: 'folder', id: share.folderId, ownerId: share.grantedById };
    }
    if (share.fileId) {
      return { type: 'file', id: share.fileId, ownerId: share.grantedById };
    }
    throw new Error('Share has no target — data integrity violation');
  }

  private generateToken(): string {
    return randomBytes(24).toString('base64url');
  }
}
