import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Folder } from "@prisma/client";
import { AccessControlService } from "../access-control/access-control.service";
import { PrismaService } from "../prisma/prisma.service";
import { TreeService } from "../tree/tree.service";
import { STORAGE_PROVIDER } from "../storage/storage.interface";
import type { StorageProvider } from "../storage/storage.interface";

export interface FolderContents {
  folder: Folder;
  breadcrumbs: Array<{ id: string; name: string }>;
  subfolders: Folder[];
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: bigint;
    createdAt: Date;
  }>;
}

export interface FolderDeletePreview {
  folderCount: number;
  fileCount: number;
  totalSize: bigint;
}

@Injectable()
export class FoldersService {
  private readonly logger = new Logger(FoldersService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly tree: TreeService,
    private readonly accessControl: AccessControlService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  public async create(
    userId: string,
    params: { name: string; dataRoomId: string; parentId?: string },
  ): Promise<Folder> {
    const dataRoom = await this.prisma.dataRoom.findUnique({
      where: { id: params.dataRoomId },
    });
    if (!dataRoom) {
      throw new NotFoundException("Data room not found");
    }
    if (dataRoom.ownerId !== userId) {
      throw new ForbiddenException("You do not have access to this data room");
    }

    let parent: Folder | null = null;
    if (params.parentId) {
      parent = await this.prisma.folder.findUnique({
        where: { id: params.parentId },
      });
      if (!parent || parent.dataRoomId !== params.dataRoomId) {
        throw new NotFoundException("Parent folder not found");
      }
    }

    await this.assertNameAvailable(
      params.dataRoomId,
      params.parentId ?? null,
      params.name,
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const folder = await tx.folder.create({
          data: {
            name: params.name,
            dataRoomId: params.dataRoomId,
            parentId: params.parentId ?? null,
            path: "", // placeholder, filled in immediately below
          },
        });

        const path = this.tree.buildChildPath(parent?.path ?? null, folder.id);
        const updated = await tx.folder.update({
          where: { id: folder.id },
          data: { path },
        });

        return updated;
      });
    } catch (error: unknown) {
      this.logger.error("Failed to create folder", error);
      throw error;
    }
  }

  public async getContents(
    folderId: string,
    userId?: string,
  ): Promise<FolderContents> {
    await this.accessControl.assertCanViewFolder(folderId, userId);
    const folder = await this.findByIdOrThrow(folderId);

    const [subfolders, files, breadcrumbs] = await Promise.all([
      this.prisma.folder.findMany({
        where: { parentId: folderId },
        orderBy: { name: "asc" },
      }),
      this.prisma.file.findMany({
        where: { folderId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          createdAt: true,
        },
      }),
      this.buildBreadcrumbs(folder),
    ]);

    return { folder, breadcrumbs, subfolders, files };
  }

  public async rename(
    folderId: string,
    userId: string,
    name: string,
  ): Promise<Folder> {
    const folder = await this.findByIdOrThrow(folderId);
    await this.assertDataRoomOwner(folder.dataRoomId, userId);
    await this.assertNameAvailable(
      folder.dataRoomId,
      folder.parentId,
      name,
      folderId,
    );

    try {
      return await this.prisma.folder.update({
        where: { id: folderId },
        data: { name },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to rename folder ${folderId}`, error);
      throw error;
    }
  }

  public async move(
    folderId: string,
    userId: string,
    targetParentId: string | undefined,
  ): Promise<Folder> {
    const folder = await this.findByIdOrThrow(folderId);
    await this.assertDataRoomOwner(folder.dataRoomId, userId);

    let targetParent: Folder | null = null;
    if (targetParentId) {
      targetParent = await this.prisma.folder.findUnique({
        where: { id: targetParentId },
      });
      if (!targetParent || targetParent.dataRoomId !== folder.dataRoomId) {
        throw new NotFoundException("Target folder not found");
      }
      if (
        targetParentId === folderId ||
        this.tree.pathContainsId(targetParent.path, folderId)
      ) {
        throw new BadRequestException(
          "Cannot move a folder into itself or its own subfolder",
        );
      }
    }

    await this.assertNameAvailable(
      folder.dataRoomId,
      targetParentId ?? null,
      folder.name,
      folderId,
    );

    const sourceParent = folder.parentId
      ? await this.prisma.folder.findUnique({ where: { id: folder.parentId } })
      : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const newPath = this.tree.buildChildPath(
          targetParent?.path ?? null,
          folder.id,
        );

        const updated = await tx.folder.update({
          where: { id: folderId },
          data: { parentId: targetParentId ?? null, path: newPath },
        });

        // Descendants' paths must be rewritten too, since they embed
        // this folder's id-path prefix.
        const descendants = await tx.folder.findMany({
          where: { path: { startsWith: folder.path } },
        });

        for (const descendant of descendants) {
          const rewritten = newPath + descendant.path.slice(folder.path.length);
          await tx.folder.update({
            where: { id: descendant.id },
            data: { path: rewritten },
          });
        }

        // The moved folder's own aggregates travel with it: remove its
        // totalSize/itemCount from the old ancestor chain, add them to the new one.
        await this.tree.applyDelta(tx, {
          dataRoomId: folder.dataRoomId,
          folderPath: sourceParent?.path ?? null,
          sizeDelta: -folder.totalSize,
          countDelta: -folder.itemCount,
        });
        await this.tree.applyDelta(tx, {
          dataRoomId: folder.dataRoomId,
          folderPath: targetParent?.path ?? null,
          sizeDelta: folder.totalSize,
          countDelta: folder.itemCount,
        });

        return updated;
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to move folder ${folderId}`, error);
      throw error;
    }
  }

  public async getDeletePreview(
    folderId: string,
    userId: string,
  ): Promise<FolderDeletePreview> {
    const folder = await this.findByIdOrThrow(folderId);
    await this.assertDataRoomOwner(folder.dataRoomId, userId);

    const [fileAgg, folderCount] = await Promise.all([
      this.prisma.file.aggregate({
        where: {
          OR: [{ folderId }, { folder: { path: { startsWith: folder.path } } }],
        },
        _sum: { size: true },
        _count: { _all: true },
      }),
      this.prisma.folder.count({
        where: { path: { startsWith: folder.path }, id: { not: folderId } },
      }),
    ]);

    return {
      folderCount: folderCount + 1, // include the folder itself
      fileCount: fileAgg._count._all,
      totalSize: fileAgg._sum.size ?? BigInt(0),
    };
  }

  public async remove(folderId: string, userId: string): Promise<void> {
    const folder = await this.findByIdOrThrow(folderId);
    await this.assertDataRoomOwner(folder.dataRoomId, userId);

    try {
      const filesToDelete = await this.prisma.file.findMany({
        where: {
          OR: [{ folderId }, { folder: { path: { startsWith: folder.path } } }],
        },
        select: { storageKey: true },
      });

      await this.prisma.folder.delete({ where: { id: folderId } });

      if (filesToDelete.length > 0) {
        await this.storage.deleteMany(
          filesToDelete.map((file) => file.storageKey),
        );
      }
    } catch (error: unknown) {
      this.logger.error(`Failed to delete folder ${folderId}`, error);
      throw error;
    }
  }

  private async findByIdOrThrow(id: string): Promise<Folder> {
    const folder = await this.prisma.folder.findUnique({ where: { id } });
    if (!folder) {
      throw new NotFoundException("Folder not found");
    }
    return folder;
  }

  private async assertDataRoomOwner(
    dataRoomId: string,
    userId: string,
  ): Promise<void> {
    const dataRoom = await this.prisma.dataRoom.findUnique({
      where: { id: dataRoomId },
    });
    if (!dataRoom || dataRoom.ownerId !== userId) {
      throw new ForbiddenException("You do not have access to this data room");
    }
  }

  private async assertNameAvailable(
    dataRoomId: string,
    parentId: string | null,
    name: string,
    excludeFolderId?: string,
  ): Promise<void> {
    const existing = await this.prisma.folder.findFirst({
      where: {
        dataRoomId,
        parentId,
        name,
        id: excludeFolderId ? { not: excludeFolderId } : undefined,
      },
    });
    if (existing) {
      throw new ConflictException(
        `A folder named "${name}" already exists in this location`,
      );
    }
  }

  private async buildBreadcrumbs(
    folder: Folder,
  ): Promise<Array<{ id: string; name: string }>> {
    const ancestorIds = folder.path.split("/").filter(Boolean);
    if (ancestorIds.length === 0) {
      return [];
    }

    const ancestors = await this.prisma.folder.findMany({
      where: { id: { in: ancestorIds } },
      select: { id: true, name: true },
    });

    const byId = new Map(ancestors.map((a) => [a.id, a.name]));
    return ancestorIds
      .filter((id) => byId.has(id))
      .map((id) => ({ id, name: byId.get(id) as string }));
  }
}
