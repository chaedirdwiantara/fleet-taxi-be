import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCheckpointPointDto {
  @ApiPropertyOptional({ example: true, description: 'Lolos inspeksi (true/false)' })
  @IsOptional()
  @IsBoolean()
  passed?: boolean;

  @ApiPropertyOptional({ example: 'Baret halus di pintu kiri depan' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
