import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_LOOKBACK_DAYS, MIN_LOOKBACK_DAYS } from '../sync-schedule';

const RUN_AT = /^([01]\d|2[0-3]):(00|30)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateGojekPortalSyncSettingsDto {
  @ApiProperty({ example: 'finance@rental.id', description: 'Fleet Partner Portal account' })
  @IsEmail()
  @MaxLength(190)
  email!: string;

  @ApiPropertyOptional({
    description:
      'Portal password. Omit / empty = keep the stored one. Never echoed back; only its digest is stored, encrypted.',
    writeOnly: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  isEnabled!: boolean;

  @ApiProperty({ example: '05:00', description: 'Daily run time, WIB, 30-minute steps' })
  @IsString()
  @Matches(RUN_AT, { message: 'runAt must be HH:mm (WIB) on a 30-minute step, e.g. 05:30' })
  runAt!: string;

  @ApiProperty({ minimum: MIN_LOOKBACK_DAYS, maximum: MAX_LOOKBACK_DAYS, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LOOKBACK_DAYS)
  @Max(MAX_LOOKBACK_DAYS)
  lookbackDays!: number;
}

export class TestGojekPortalConnectionDto {
  @ApiPropertyOptional({ description: 'Defaults to the stored account email' })
  @IsOptional()
  @IsEmail()
  @MaxLength(190)
  email?: string;

  @ApiPropertyOptional({ description: 'Defaults to the stored password', writeOnly: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}

export class CreateGojekPortalSyncRunDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'WIB day; defaults to the schedule range',
  })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'dateFrom must be YYYY-MM-DD' })
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-07', description: 'WIB day, inclusive' })
  @IsOptional()
  @Matches(ISO_DATE, { message: 'dateTo must be YYYY-MM-DD' })
  dateTo?: string;
}

export class ListGojekPortalSyncRunsQueryDto {
  @ApiPropertyOptional({ type: Number, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ type: Number, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
