import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Share } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import type { JwtPayload } from '../auth/strategies/jwt-access.strategy';
import { AddGranteeDto } from './dto/add-grantee.dto';
import { CreateShareDto } from './dto/create-share.dto';
import type { ResolvedShare } from './shares.service';
import { SharesService } from './shares.service';

@Controller('shares')
export class SharesController {
  public constructor(private readonly sharesService: SharesService) {}

  @Post()
  public create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateShareDto,
  ): Promise<Share> {
    return this.sharesService.create(user.sub, {
      mode: dto.mode,
      dataRoomId: dto.dataRoomId,
      folderId: dto.folderId,
      fileId: dto.fileId,
    });
  }

  @Get()
  public listForTarget(
    @CurrentUser() user: JwtPayload,
    @Query('dataRoomId') dataRoomId?: string,
    @Query('folderId') folderId?: string,
    @Query('fileId') fileId?: string,
  ): Promise<Share[]> {
    return this.sharesService.listForTarget(user.sub, { dataRoomId, folderId, fileId });
  }

  @Post(':id/grantees')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async addGrantee(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddGranteeDto,
  ): Promise<void> {
    await this.sharesService.addGrantee(id, user.sub, dto.email);
  }

  @Delete(':id/grantees/:granteeUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async removeGrantee(
    @Param('id') id: string,
    @Param('granteeUserId') granteeUserId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.sharesService.removeGrantee(id, user.sub, granteeUserId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async revoke(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.sharesService.revoke(id, user.sub);
  }

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get('view/:token')
  public resolveByToken(
    @Param('token') token: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<ResolvedShare> {
    return this.sharesService.resolveByToken(token, user?.sub);
  }
}
