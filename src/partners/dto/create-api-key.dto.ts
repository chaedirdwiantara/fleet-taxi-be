import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateApiKeyDto {
  @ApiPropertyOptional({ example: 'Production integration key' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({
    isArray: true,
    example: ['pricelist', 'order:create', 'order:read'],
    description: 'Scopes granted to the key',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({ example: 60, description: 'Requests per minute' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rateLimit?: number;
}
