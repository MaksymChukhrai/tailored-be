import { Module } from '@nestjs/common';
import { DataRoomsModule } from '../data-rooms/data-rooms.module';
import { FilesModule } from '../files/files.module';
import { FoldersModule } from '../folders/folders.module';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

@Module({
  imports: [DataRoomsModule, FoldersModule, FilesModule],
  controllers: [SharesController],
  providers: [SharesService],
  exports: [SharesService],
})
export class SharesModule {}
