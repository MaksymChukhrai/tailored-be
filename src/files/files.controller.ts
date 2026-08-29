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
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { File } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { JwtPayload } from '../auth/strategies/jwt-access.strategy';
import { MoveFileDto } from './dto/move-file.dto';
import { UpdateFileDto } from './dto/update-file.dto';
import { FilesService } from './files.service';

interface UploadedMulterFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

@Controller('files')
export class FilesController {
  public constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  public upload(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: UploadedMulterFile,
    @Query('dataRoomId') dataRoomId: string,
    @Query('folderId') folderId?: string,
  ): Promise<File> {
    return this.filesService.upload(user.sub, {
      dataRoomId,
      folderId,
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
    });
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id/download')
  public async getDownloadUrl(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<{ url: string }> {
    const url = await this.filesService.getDownloadUrl(id, user?.sub);
    return { url };
  }

  @Patch(':id')
  public rename(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateFileDto,
  ): Promise<File> {
    return this.filesService.rename(id, user.sub, dto.name);
  }

  @Patch(':id/move')
  public move(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: MoveFileDto,
  ): Promise<File> {
    return this.filesService.move(id, user.sub, dto.targetFolderId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.filesService.remove(id, user.sub);
  }
}
