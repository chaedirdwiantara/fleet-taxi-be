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

export class UpsertGojekTargetDto {
  @ApiPropertyOptional({ description: 'Daily target in integer rupiah' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fleetTarget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rentalPartner?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deliveryBatch?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serviceArea?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  regionId?: number;
}

export class UpsertGrabTargetDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rentalPartner?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vehicleType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  city?: string;
}
