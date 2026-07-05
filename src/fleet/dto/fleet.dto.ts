import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';

export class CreateExceptionDto {
  @ApiProperty({ example: 'B1234XY' })
  @IsString()
  vehiclePlate!: string;

  @ApiProperty({ example: '2026-07-10', description: 'YYYY-MM-DD' })
  @IsISO8601({ strict: true })
  exceptionDate!: string;

  @ApiPropertyOptional({ example: 'Perbaikan bengkel' })
  @IsOptional()
  @IsString()
  keterangan?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'true = bebas setoran (reduces target days)',
  })
  @IsOptional()
  @IsBoolean()
  isBebasSetoran?: boolean;
}

/**
 * Superset target upsert DTO (Gojek fields + Grab fields, all optional).
 * A single concrete class — NOT an intersection type — so the global
 * ValidationPipe actually runs (an intersection erases to `Object` at runtime,
 * which ValidationPipe skips). The service picks the relevant subset per platform.
 */
export class UpsertTargetDto {
  @ApiPropertyOptional({ description: 'Daily target in integer rupiah (Gojek)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fleetTarget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rentalPartner?: string;

  @ApiPropertyOptional({ description: 'Gojek only' })
  @IsOptional()
  @IsString()
  deliveryBatch?: string;

  @ApiPropertyOptional({ description: 'Gojek only' })
  @IsOptional()
  @IsString()
  serviceArea?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleType?: string;

  @ApiPropertyOptional({ description: 'Gojek only' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  regionId?: number;

  @ApiPropertyOptional({ description: 'Grab only' })
  @IsOptional()
  @IsString()
  city?: string;
}
