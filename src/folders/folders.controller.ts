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
  UseGuards,
} from '@nestjs/common';
import { Folder } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { JwtPayload } from '../auth/strategies/jwt-access.strategy';
import { CreateFolderDto } from './dto/create-folder.dto';
import { MoveFolderDto } from './dto/move-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import type { FolderContents, FolderDeletePreview } from './folders.service';
import { FoldersService } from './folders.service';

@Controller('folders')
export class FoldersController {
  public constructor(private readonly foldersService: FoldersService) {}

  @Post()
  public create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateFolderDto,
  ): Promise<Folder> {
    return this.foldersService.create(user.sub, {
      name: dto.name,
      dataRoomId: dto.dataRoomId,
      parentId: dto.parentId,
    });
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  public getContents(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<FolderContents> {
    return this.foldersService.getContents(id, user?.sub);
  }

  @Patch(':id')
  public rename(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateFolderDto,
  ): Promise<Folder> {
    return this.foldersService.rename(id, user.sub, dto.name);
  }

  @Patch(':id/move')
  public move(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: MoveFolderDto,
  ): Promise<Folder> {
    return this.foldersService.move(id, user.sub, dto.targetParentId);
  }

  @Get(':id/delete-preview')
  public getDeletePreview(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<FolderDeletePreview> {
    return this.foldersService.getDeletePreview(id, user.sub);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.foldersService.remove(id, user.sub);
  }
}
