import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListActivityLogsQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  pageSize?: string;

  @ApiPropertyOptional({ enum: ['admin', 'partner'] })
  @IsOptional()
  @IsIn(['admin', 'partner'])
  audience?: 'admin' | 'partner';

  @ApiPropertyOptional({ description: 'Filter by actor email (substring match)' })
  @IsOptional()
  @IsString()
  actor?: string;

  @ApiPropertyOptional({
    enum: [
      'auth.login.success',
      'auth.login.failure',
      'auth.logout',
      'auth.password_change',
      'mutation.create',
      'mutation.update',
      'mutation.delete',
    ],
  })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ example: '2026-07-01', description: 'Inclusive lower bound (ISO date)' })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-07-31', description: 'Inclusive upper bound (ISO date)' })
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Free-text search over actor email, path, and resource' })
  @IsOptional()
  @IsString()
  search?: string;
}
