import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateDataRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public name!: string;
}
