import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateDataRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  public name!: string;
}
