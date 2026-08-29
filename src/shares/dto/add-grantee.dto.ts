import { IsEmail } from 'class-validator';

export class AddGranteeDto {
  @IsEmail()
  public email!: string;
}
