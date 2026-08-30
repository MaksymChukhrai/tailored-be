import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { DataRoom, Folder, File } from "@prisma/client";
import { AccessControlService } from "../access-control/access-control.service";
import { PrismaService } from "../prisma/prisma.service";
import { STORAGE_PROVIDER } from "../storage/storage.interface";
import type { StorageProvider } from "../storage/storage.interface";

export interface DataRoomSummary extends DataRoom {
  rootFolderCount: number;
  rootFileCount: number;
}

export interface DataRoomRootContents {
  dataRoom: DataRoom;
  subfolders: Folder[];
  files: File[];
}

@Injectable()
export class DataRoomsService {
  private readonly logger = new Logger(DataRoomsService.name);

  public constructor(
    private readonly prisma: PrismaService,
    private readonly accessControl: AccessControlService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  public async create(ownerId: string, name: string): Promise<DataRoom> {
    try {
      return await this.prisma.dataRoom.create({
        data: { name, ownerId },
      });
    } catch (error: unknown) {
      this.logger.error(
        `Failed to create data room for user ${ownerId}`,
        error,
      );
      throw error;
    }
  }

  public async findAllForUser(userId: string): Promise<DataRoom[]> {
    try {
      return await this.prisma.dataRoom.findMany({
        where: {
          OR: [
            { ownerId: userId },
            {
              shares: {
                some: { grantees: { some: { userId } }, revokedAt: null },
              },
            },
          ],
        },
        orderBy: { updatedAt: "desc" },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to list data rooms for user ${userId}`, error);
      throw error;
    }
  }

  public async findOne(id: string, userId: string): Promise<DataRoom> {
    const dataRoom = await this.findByIdOrThrow(id);
    this.assertOwner(dataRoom, userId);
    return dataRoom;
  }

  /**
   * Lists the top-level (parentId/folderId = null) folders and files of a
   * Data Room. Access is granted to the owner or to anyone covered by a
   * live share on the Data Room — used both for the owner's normal view
   * and for anyone viewing via a public/permissioned share link.
   */
  public async getRootContents(
    dataRoomId: string,
    userId?: string,
  ): Promise<DataRoomRootContents> {
    await this.accessControl.assertCanViewDataRoom(dataRoomId, userId);
    const dataRoom = await this.findByIdOrThrow(dataRoomId);

    const [subfolders, files] = await Promise.all([
      this.prisma.folder.findMany({
        where: { dataRoomId, parentId: null },
        orderBy: { name: "asc" },
      }),
      this.prisma.file.findMany({
        where: { dataRoomId, folderId: null },
        orderBy: { name: "asc" },
      }),
    ]);

    return { dataRoom, subfolders, files };
  }

  public async rename(
    id: string,
    userId: string,
    name: string,
  ): Promise<DataRoom> {
    const dataRoom = await this.findByIdOrThrow(id);
    this.assertOwner(dataRoom, userId);

    try {
      return await this.prisma.dataRoom.update({
        where: { id },
        data: { name },
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to rename data room ${id}`, error);
      throw error;
    }
  }

  public async remove(id: string, userId: string): Promise<void> {
    const dataRoom = await this.findByIdOrThrow(id);
    this.assertOwner(dataRoom, userId);

    try {
      const files = await this.prisma.file.findMany({
        where: { dataRoomId: id },
        select: { storageKey: true },
      });

      await this.prisma.dataRoom.delete({ where: { id } });

      if (files.length > 0) {
        await this.storage.deleteMany(files.map((file) => file.storageKey));
      }
    } catch (error: unknown) {
      this.logger.error(`Failed to delete data room ${id}`, error);
      throw error;
    }
  }

  private async findByIdOrThrow(id: string): Promise<DataRoom> {
    const dataRoom = await this.prisma.dataRoom.findUnique({ where: { id } });
    if (!dataRoom) {
      throw new NotFoundException("Data room not found");
    }
    return dataRoom;
  }

  private assertOwner(dataRoom: DataRoom, userId: string): void {
    if (dataRoom.ownerId !== userId) {
      throw new ForbiddenException("You do not have access to this data room");
    }
  }
}
