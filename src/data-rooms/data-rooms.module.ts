import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { StorageModule } from '../storage/storage.module';
import { DataRoomsController } from './data-rooms.controller';
import { DataRoomsService } from './data-rooms.service';

@Module({
  imports: [StorageModule, AccessControlModule],
  controllers: [DataRoomsController],
  providers: [DataRoomsService],
  exports: [DataRoomsService],
})
export class DataRoomsModule {}
