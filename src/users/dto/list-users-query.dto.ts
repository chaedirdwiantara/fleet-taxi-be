import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class ListUsersQueryDto {
  @ApiPropertyOptional({
    enum: ['admin', 'partner'],
    default: 'admin',
    description: 'admin = staff users (no partner); partner = partner-portal users',
  })
  @IsOptional()
  @IsIn(['admin', 'partner'])
  type?: 'admin' | 'partner';

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  page?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  pageSize?: string;
}
