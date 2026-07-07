import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ADMIN_ROLES } from './create-admin-user.dto';

/**
 * Partial account edit for super_admin user-management. Every field optional;
 * only the ones present are changed. `roles` applies to admin/staff accounts,
 * `partnerId` re-homes a partner-portal account to a different partner org.
 */
export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  fullName?: string;

  @ApiPropertyOptional({ description: 'Enable/disable login' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ isArray: true, enum: ADMIN_ROLES, description: 'Admin/staff roles' })
  @IsOptional()
  @ArrayNotEmpty()
  @IsIn(ADMIN_ROLES, { each: true })
  roles?: string[];

  @ApiPropertyOptional({ description: 'Move a partner-portal user to another partner org' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  partnerId?: number;

  @ApiPropertyOptional({
    minLength: 8,
    description: 'Reset password (forces change on next login)',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password?: string;
}
