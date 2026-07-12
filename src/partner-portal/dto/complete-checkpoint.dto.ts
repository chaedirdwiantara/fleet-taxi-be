import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CompleteCheckpointDto {
  @ApiProperty({ example: 15320, description: 'Odometer (km)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  odometerKm!: number;

  @ApiProperty({ example: 87, description: 'Level baterai (%)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPercent!: number;

  @ApiPropertyOptional({ example: 'Serah terima berjalan lancar' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  generalNotes?: string;
}
