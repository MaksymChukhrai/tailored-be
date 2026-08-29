import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ShareMode } from '@prisma/client';

export class CreateShareDto {
  @IsEnum(ShareMode)
  public mode!: ShareMode;

  // Exactly one of these three must be provided — validated in the service.
  @IsOptional()
  @IsUUID()
  public dataRoomId?: string;

  @IsOptional()
  @IsUUID()
  public folderId?: string;

  @IsOptional()
  @IsUUID()
  public fileId?: string;
}
