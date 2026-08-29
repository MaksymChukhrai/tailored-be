import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { DataRoom } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt-access.strategy';
import type { DataRoomRootContents } from './data-rooms.service';
import { DataRoomsService } from './data-rooms.service';
import { CreateDataRoomDto } from './dto/create-data-room.dto';
import { UpdateDataRoomDto } from './dto/update-data-room.dto';

@Controller('data-rooms')
export class DataRoomsController {
  public constructor(private readonly dataRoomsService: DataRoomsService) {}

  @Post()
  public create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDataRoomDto,
  ): Promise<DataRoom> {
    return this.dataRoomsService.create(user.sub, dto.name);
  }

  @Get()
  public findAll(@CurrentUser() user: JwtPayload): Promise<DataRoom[]> {
    return this.dataRoomsService.findAllForUser(user.sub);
  }

  @Get(':id')
  public findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<DataRoom> {
    return this.dataRoomsService.findOne(id, user.sub);
  }

  @Get(':id/contents')
  public getRootContents(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<DataRoomRootContents> {
    return this.dataRoomsService.getRootContents(id, user.sub);
  }

  @Patch(':id')
  public rename(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateDataRoomDto,
  ): Promise<DataRoom> {
    return this.dataRoomsService.rename(id, user.sub, dto.name);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.dataRoomsService.remove(id, user.sub);
  }
}
