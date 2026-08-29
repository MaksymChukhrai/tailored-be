import { IsOptional, IsUUID } from 'class-validator';

export class MoveFolderDto {
  // Omitted or null = move to the Data Room root
  @IsOptional()
  @IsUUID()
  public targetParentId?: string;
}
