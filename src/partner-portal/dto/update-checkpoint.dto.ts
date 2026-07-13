import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Partial header update while the checkpoint is still a draft. */
export class UpdateCheckpointDto {
  @ApiPropertyOptional({ example: 'Budi Santoso' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  counterpartName?: string;

  @ApiPropertyOptional({ example: '0812xxxxxxx' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  counterpartPhone?: string;

  @ApiPropertyOptional({ example: 15320, description: 'Odometer (km)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  odometerKm?: number;

  @ApiPropertyOptional({ example: 87, description: 'Level baterai (%)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPercent?: number;

  @ApiPropertyOptional({ example: 'Unit dalam kondisi bersih' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  generalNotes?: string;
}
