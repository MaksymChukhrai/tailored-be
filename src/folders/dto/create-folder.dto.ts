import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public name!: string;

  @IsUUID()
  public dataRoomId!: string;

  @IsOptional()
  @IsUUID()
  public parentId?: string;
}
