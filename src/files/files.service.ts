import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { File } from '@prisma/client';
import { AccessControlService } from '../access-control/access-control.service';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../storage/storage.interface';
import type { StorageProvider } from '../storage/storage.interface';
import { randomUUID } from 'node:crypto';
import { TreeService } from '../tree/tree.service';

export interface UploadFileParams {
  dataRoomId: string;
  folderId?: string;
  originalName: string;
  mimeType: string;
  buffer: Buffer;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly tree: TreeService,
    private readonly accessControl: AccessControlService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  public async upload(userId: string, params: UploadFileParams): Promise<File> {
    const dataRoom = await this.prisma.dataRoom.findUnique({
      where: { id: params.dataRoomId },
    });
    if (!dataRoom) {
      throw new NotFoundException('Data room not found');
    }
    if (dataRoom.ownerId !== userId) {
      throw new ForbiddenException('You do not have access to this data room');
    }

    let folder = null;
    if (params.folderId) {
      folder = await this.prisma.folder.findUnique({ where: { id: params.folderId } });
      if (!folder || folder.dataRoomId !== params.dataRoomId) {
        throw new NotFoundException('Folder not found');
      }
    }

    const uniqueName = await this.resolveNameConflict(
      params.dataRoomId,
      params.folderId ?? null,
      params.originalName,
    );

    const storageKey = this.buildStorageKey(params.dataRoomId, params.originalName);

    try {
      await this.storage.upload({
        key: storageKey,
        body: params.buffer,
        contentType: params.mimeType,
      });

      return await this.prisma.$transaction(async (tx) => {
        const file = await tx.file.create({
          data: {
            name: uniqueName,
            mimeType: params.mimeType,
            size: BigInt(params.buffer.length),
            storageKey,
            dataRoomId: params.dataRoomId,
            folderId: params.folderId ?? null,
            uploadedById: userId,
          },
        });

        await this.tree.applyDelta(tx, {
          dataRoomId: params.dataRoomId,
          folderPath: folder?.path ?? null,
          sizeDelta: file.size,
          countDelta: 1,
        });

        return file;
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to upload file "${params.originalName}"`, error);
      throw error;
    }
  }

  public async getDownloadUrl(fileId: string, userId?: string): Promise<string> {
    await this.accessControl.assertCanViewFile(fileId, userId);
    const file = await this.findByIdOrThrow(fileId);

    try {
      return await this.storage.getSignedDownloadUrl(file.storageKey);
    } catch (error: unknown) {
      this.logger.error(`Failed to get download URL for file ${fileId}`, error);
      throw error;
    }
  }

  public async rename(fileId: string, userId: string, name: string): Promise<File> {
    const file = await this.findByIdOrThrow(fileId);
    await this.assertDataRoomOwner(file.dataRoomId, userId);

    const uniqueName = await this.resolveNameConflict(
      file.dataRoomId,
      file.folderId,
      name,
      fileId,
    );

    try {
      return await this.prisma.file.update({
        where: { id: fileId },
        data: { name: uniqueName },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to rename file ${fileId}`, error);
      throw error;
    }
  }

  public async move(
    fileId: string,
    userId: string,
    targetFolderId: string | undefined,
  ): Promise<File> {
    const file = await this.findByIdOrThrow(fileId);
    await this.assertDataRoomOwner(file.dataRoomId, userId);

    let targetFolder = null;
    if (targetFolderId) {
      targetFolder = await this.prisma.folder.findUnique({ where: { id: targetFolderId } });
      if (!targetFolder || targetFolder.dataRoomId !== file.dataRoomId) {
        throw new NotFoundException('Target folder not found');
      }
    }

    const uniqueName = await this.resolveNameConflict(
      file.dataRoomId,
      targetFolderId ?? null,
      file.name,
      fileId,
    );

    const sourceFolder = file.folderId
      ? await this.prisma.folder.findUnique({ where: { id: file.folderId } })
      : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.file.update({
          where: { id: fileId },
          data: { folderId: targetFolderId ?? null, name: uniqueName },
        });

        // Move affects two subtrees' aggregates: remove from source, add to target.
        await this.tree.applyDelta(tx, {
          dataRoomId: file.dataRoomId,
          folderPath: sourceFolder?.path ?? null,
          sizeDelta: -file.size,
          countDelta: -1,
        });
        await this.tree.applyDelta(tx, {
          dataRoomId: file.dataRoomId,
          folderPath: targetFolder?.path ?? null,
          sizeDelta: file.size,
          countDelta: 1,
        });

        return updated;
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to move file ${fileId}`, error);
      throw error;
    }
  }

  public async remove(fileId: string, userId: string): Promise<void> {
    const file = await this.findByIdOrThrow(fileId);
    await this.assertDataRoomOwner(file.dataRoomId, userId);

    const folder = file.folderId
      ? await this.prisma.folder.findUnique({ where: { id: file.folderId } })
      : null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.file.delete({ where: { id: fileId } });
        await this.tree.applyDelta(tx, {
          dataRoomId: file.dataRoomId,
          folderPath: folder?.path ?? null,
          sizeDelta: -file.size,
          countDelta: -1,
        });
      });

      await this.storage.delete(file.storageKey);
    } catch (error: unknown) {
      this.logger.error(`Failed to delete file ${fileId}`, error);
      throw error;
    }
  }

  private async findByIdOrThrow(id: string): Promise<File> {
    const file = await this.prisma.file.findUnique({ where: { id } });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    return file;
  }

  private async assertDataRoomOwner(dataRoomId: string, userId: string): Promise<void> {
    const dataRoom = await this.prisma.dataRoom.findUnique({ where: { id: dataRoomId } });
    if (!dataRoom || dataRoom.ownerId !== userId) {
      throw new ForbiddenException('You do not have access to this data room');
    }
  }

  private buildStorageKey(dataRoomId: string, originalName: string): string {
    return `${dataRoomId}/${randomUUID()}-${originalName}`;
  }

  /**
   * Resolves a name conflict the way most file managers do: if "report.pdf"
   * already exists in this folder, tries "report (1).pdf", "report (2).pdf",
   * etc. until a free name is found. This lets uploads/renames/moves proceed
   * without forcing the user to pick a name up front.
   */
  private async resolveNameConflict(
    dataRoomId: string,
    folderId: string | null,
    desiredName: string,
    excludeFileId?: string,
  ): Promise<string> {
    const existing = await this.prisma.file.findFirst({
      where: {
        dataRoomId,
        folderId,
        name: desiredName,
        id: excludeFileId ? { not: excludeFileId } : undefined,
      },
    });

    if (!existing) {
      return desiredName;
    }

    const lastDotIndex = desiredName.lastIndexOf('.');
    const base = lastDotIndex > 0 ? desiredName.slice(0, lastDotIndex) : desiredName;
    const extension = lastDotIndex > 0 ? desiredName.slice(lastDotIndex) : '';

    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const candidate = `${base} (${suffix})${extension}`;
      const conflict = await this.prisma.file.findFirst({
        where: {
          dataRoomId,
          folderId,
          name: candidate,
          id: excludeFileId ? { not: excludeFileId } : undefined,
        },
      });
      if (!conflict) {
        return candidate;
      }
    }

    throw new Error('Unable to resolve file name conflict after 999 attempts');
  }
}
