import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreatePartnerUserDto {
  @ApiProperty({ example: 'portal@bhisa.example' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Bhisa Portal User' })
  @IsString()
  @MinLength(1)
  fullName!: string;

  @ApiProperty({ example: 'initial-password', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password!: string;
}
