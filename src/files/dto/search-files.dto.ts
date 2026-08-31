import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class SearchFilesDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  public q!: string;
}
