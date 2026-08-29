import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public name!: string;
}
