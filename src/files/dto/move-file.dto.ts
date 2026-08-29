import { IsOptional, IsUUID } from 'class-validator';

export class MoveFileDto {
  // Omitted or null = move to the Data Room root
  @IsOptional()
  @IsUUID()
  public targetFolderId?: string;
}
