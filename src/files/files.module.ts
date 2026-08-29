import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { AccessControlModule } from '../access-control/access-control.module';
import { StorageModule } from '../storage/storage.module';
import { TreeModule } from '../tree/tree.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
@Module({
  imports: [
    StorageModule,
    TreeModule,
    AccessControlModule,
    MulterModule.register({
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
    }),
  ],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
