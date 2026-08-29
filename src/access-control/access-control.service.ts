import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ShareMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ViewableEntityType = 'dataRoom' | 'folder' | 'file';

/**
 * Single source of truth for "can this user view this entity". An entity
 * is viewable by its Data Room owner, or by anyone covered by a live
 * (non-revoked) Share on the entity itself or any of its ancestors —
 * sharing a folder or a Data Room implicitly grants read access to
 * everything nested inside it.
 *
 * Only used to gate read operations. Write operations (create, rename,
 * move, delete) remain owner-only and are checked directly in their
 * respective services, since shares in this MVP are always read-only.
 */
@Injectable()
export class AccessControlService {
  private readonly logger = new Logger(AccessControlService.name);

  public constructor(private readonly prisma: PrismaService) {}

  public async assertCanViewDataRoom(dataRoomId: string, userId?: string): Promise<void> {
    const dataRoom = await this.prisma.dataRoom.findUnique({ where: { id: dataRoomId } });
    if (!dataRoom) {
      throw new NotFoundException('Data room not found');
    }
    if (userId && dataRoom.ownerId === userId) {
      return;
    }

    const hasAccess = await this.hasLiveShare({ dataRoomId }, userId);
    if (!hasAccess) {
      throw new ForbiddenException('You do not have access to this data room');
    }
  }

  public async assertCanViewFolder(folderId: string, userId?: string): Promise<void> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
      include: { dataRoom: true },
    });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    if (userId && folder.dataRoom.ownerId === userId) {
      return;
    }

    const ancestorIds = folder.path.split('/').filter(Boolean);
    const hasAccess = await this.hasLiveShare(
      { dataRoomId: folder.dataRoomId, folderIds: ancestorIds },
      userId,
    );
    if (!hasAccess) {
      throw new ForbiddenException('You do not have access to this folder');
    }
  }

  public async assertCanViewFile(fileId: string, userId?: string): Promise<void> {
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
      include: { dataRoom: true, folder: true },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    if (userId && file.dataRoom.ownerId === userId) {
      return;
    }

    const ancestorIds = file.folder ? file.folder.path.split('/').filter(Boolean) : [];
    const hasAccess = await this.hasLiveShare(
      { dataRoomId: file.dataRoomId, folderIds: ancestorIds, fileId: file.id },
      userId,
    );
    if (!hasAccess) {
      throw new ForbiddenException('You do not have access to this file');
    }
  }

  /**
   * Checks for any non-revoked Share targeting the Data Room itself, any
   * ancestor folder, or (for files) the file directly. PUBLIC_LINK shares
   * grant access to anyone; PERMISSIONED shares require the user to be a
   * listed grantee.
   */
  private async hasLiveShare(
    scope: { dataRoomId: string; folderIds?: string[]; fileId?: string },
    userId?: string,
  ): Promise<boolean> {
    try {
      const shares = await this.prisma.share.findMany({
        where: {
          revokedAt: null,
          OR: [
            { dataRoomId: scope.dataRoomId },
            ...(scope.folderIds && scope.folderIds.length > 0
              ? [{ folderId: { in: scope.folderIds } }]
              : []),
            ...(scope.fileId ? [{ fileId: scope.fileId }] : []),
          ],
        },
        include: { grantees: true },
      });

      return shares.some((share) => {
        if (share.mode === ShareMode.PUBLIC_LINK) {
          return true;
        }
        return userId ? share.grantees.some((g) => g.userId === userId) : false;
      });
    } catch (error: unknown) {
      this.logger.error('Failed to evaluate share-based access', error);
      throw error;
    }
  }
}
