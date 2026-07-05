import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsEmail, IsIn, IsString, MinLength } from 'class-validator';

/** Roles assignable to an admin/staff account (never `partner`). */
export const ADMIN_ROLES = ['admin', 'finance', 'super_admin'] as const;

export class CreateAdminUserDto {
  @ApiProperty({ example: 'finance@fleet-taxi.id' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Budi Finance' })
  @IsString()
  @MinLength(1)
  fullName!: string;

  @ApiProperty({ example: 'initial-password', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password!: string;

  @ApiProperty({
    isArray: true,
    enum: ADMIN_ROLES,
    example: ['admin'],
    description: 'One or more staff roles (admin, finance, super_admin)',
  })
  @ArrayNotEmpty()
  @IsIn(ADMIN_ROLES, { each: true })
  roles!: string[];
}
