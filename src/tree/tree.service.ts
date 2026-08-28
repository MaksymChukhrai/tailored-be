import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type TransactionClient = Prisma.TransactionClient;

/**
 * Centralizes materialized-path and denormalized-aggregate maintenance
 * for the Folder/File tree. Every mutation that adds, removes, or moves
 * an item must go through this service so that `path`, `totalSize`, and
 * `itemCount` stay consistent without a recursive SUM query on every read.
 */
@Injectable()
export class TreeService {
  private readonly logger = new Logger(TreeService.name);

  public constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds the materialized path for a new folder given its parent.
   * Root folders (no parent) get "/{ownFutureId}/" once created;
   * callers pass the parent's path plus the new folder's own id.
   */
  public buildChildPath(parentPath: string | null, folderId: string): string {
    const base = parentPath ?? '/';
    return `${base}${folderId}/`;
  }

  /**
   * True if `candidateAncestorId` is an ancestor of (or equal to) the
   * folder identified by `path`. Used to block moving a folder into
   * its own descendant, which would corrupt the tree.
   */
  public pathContainsId(path: string, candidateAncestorId: string): boolean {
    return path.split('/').filter(Boolean).includes(candidateAncestorId);
  }

  /**
   * Propagates a size/count delta up the ancestor chain of a folder,
   * plus the owning Data Room. Called within the same transaction as
   * the file/folder mutation that produced the delta, so aggregates
   * never drift out of sync with actual content.
   */
  public async applyDelta(
    tx: TransactionClient,
    params: {
      dataRoomId: string;
      folderPath: string | null; // null = item lives at Data Room root
      sizeDelta: bigint;
      countDelta: number;
    },
  ): Promise<void> {
    try {
      const ancestorIds = params.folderPath
        ? params.folderPath.split('/').filter(Boolean)
        : [];

      if (ancestorIds.length > 0) {
        await tx.folder.updateMany({
          where: { id: { in: ancestorIds } },
          data: {
            totalSize: { increment: params.sizeDelta },
            itemCount: { increment: params.countDelta },
          },
        });
      }

      await tx.dataRoom.update({
        where: { id: params.dataRoomId },
        data: {
          totalSize: { increment: params.sizeDelta },
          itemCount: { increment: params.countDelta },
        },
      });
    } catch (error: unknown) {
      this.logger.error('Failed to apply tree aggregate delta', error);
      throw error;
    }
  }

  /**
   * Recomputes totalSize/itemCount for a folder subtree from scratch by
   * scanning descendants via the materialized path prefix. Used as a
   * repair/reconciliation path (e.g. after a move) rather than on every
   * read — reads always use the denormalized columns.
   */
  public async recomputeSubtreeAggregates(
    tx: TransactionClient,
    folderId: string,
    folderPath: string,
  ): Promise<{ totalSize: bigint; itemCount: number }> {
    const [fileAgg, descendantFolders] = await Promise.all([
      tx.file.aggregate({
        where: {
          OR: [
            { folderId },
            { folder: { path: { startsWith: folderPath } } },
          ],
        },
        _sum: { size: true },
        _count: { _all: true },
      }),
      tx.folder.count({
        where: { path: { startsWith: folderPath }, id: { not: folderId } },
      }),
    ]);

    const totalSize = fileAgg._sum.size ?? BigInt(0);
    const itemCount = fileAgg._count._all + descendantFolders;

    await tx.folder.update({
      where: { id: folderId },
      data: { totalSize, itemCount },
    });

    return { totalSize, itemCount };
  }
}
