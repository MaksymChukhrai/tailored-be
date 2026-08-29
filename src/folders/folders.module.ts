import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { StorageModule } from '../storage/storage.module';
import { TreeModule } from '../tree/tree.module';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
@Module({
  imports: [StorageModule, TreeModule, AccessControlModule],
  controllers: [FoldersController],
  providers: [FoldersService],
  exports: [FoldersService],
})
export class FoldersModule {}
