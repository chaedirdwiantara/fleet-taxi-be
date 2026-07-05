import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'current-password' })
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @ApiProperty({ example: 'new-strong-password', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'newPassword must be at least 8 characters' })
  newPassword!: string;
}
