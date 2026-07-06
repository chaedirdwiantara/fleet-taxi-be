import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';

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

/**
 * Edit an import DETAIL row — the faithful port of the legacy
 * AdminFleetMonitoringController::postEditDriver detail-update branch.
 *
 * Two modes (mutually exclusive):
 *  • `detailId` set  → edit exactly that fleet_import_details row. This is how a
 *    "Manual Payment tanpa plat" row is given a plate and/or toggled
 *    Masuk/Tidak Masuk Setoran.
 *  • `plate` + `month` + `year` → rename driver / re-plate EVERY detail of that
 *    plated vehicle in the period.
 * Target/grouping metadata is upserted separately via PUT targets/:plate.
 */
export class EditDriverDto {
  @ApiPropertyOptional({ description: 'fleet_import_details.id (manual-row / single-detail edit)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  detailId?: number;

  @ApiPropertyOptional({ description: 'Existing normalized plate (by-plate edit across a period)' })
  @IsOptional()
  @IsString()
  plate?: string;

  @ApiPropertyOptional({ description: 'Partition period month (1..12)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  month?: number;

  @ApiPropertyOptional({ description: 'Partition period year' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  year?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  driverName?: string;

  @ApiPropertyOptional({ description: 'New plate to assign (normalized server-side)' })
  @IsOptional()
  @IsString()
  vehiclePlate?: string;

  @ApiPropertyOptional({
    description: '1 = Masuk Setoran, 0 = Tidak Masuk Setoran (manual payment only)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1])
  isManualPaymentSetoran?: number;

  @ApiPropertyOptional({ description: 'Reason shown when Tidak Masuk Setoran' })
  @IsOptional()
  @IsString()
  manualPaymentNote?: string;
}
