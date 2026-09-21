import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PAYMENT_STATUSES, PRICE_UNITS, RENTAL_TYPES } from '../rental-presenter';
import { RENTAL_MAX_PROOFS } from '../rental-proof.constants';

/** Create/update a rental transaction (Rental Monitoring, legacy jadwal-mobil-cogs). */
export class CreateRentalDto {
  @ApiProperty({ example: 'B 1793 SCP', description: 'Nomor plat (as entered)' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  plateNumber!: string;

  @ApiPropertyOptional({ example: 'Air EV' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleType?: string;

  @ApiPropertyOptional({ example: 'Jakarta' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;

  @ApiProperty({ example: '2026-07-01', description: 'YYYY-MM-DD, inclusive' })
  @IsISO8601({ strict: true })
  startDate!: string;

  @ApiProperty({ example: '2026-07-27', description: 'YYYY-MM-DD, inclusive' })
  @IsISO8601({ strict: true })
  endDate!: string;

  @ApiProperty({ example: 450000, description: 'Integer rupiah, per priceUnit' })
  @IsInt()
  @Min(1)
  price!: number;

  @ApiPropertyOptional({ enum: PRICE_UNITS, description: "Default 'hari'" })
  @IsOptional()
  @IsIn(PRICE_UNITS)
  priceUnit?: (typeof PRICE_UNITS)[number];

  @ApiProperty({ example: 335833, description: 'COGS per day, integer rupiah' })
  @IsInt()
  @Min(0)
  cogsPerDay!: number;

  @ApiPropertyOptional({ example: 'Air EV' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cogsType?: string;

  @ApiPropertyOptional({
    description: 'TOTAL for the transaction (not per day), integer rupiah. Default 0.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  additionalCost?: number;

  @ApiPropertyOptional({ example: 'Antar-jemput bandara' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  additionalCostDescription?: string;

  @ApiPropertyOptional({ description: 'Integer rupiah. Default 0.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  deposit?: number;

  @ApiPropertyOptional({ enum: RENTAL_TYPES })
  @IsOptional()
  @IsIn(RENTAL_TYPES)
  rentalType?: (typeof RENTAL_TYPES)[number];

  @ApiPropertyOptional({ example: 'Instagram' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  infoSource?: string;

  @ApiPropertyOptional({ example: 'Jabodetabek' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  serviceArea?: string;

  @ApiPropertyOptional({ example: 'Budi Santoso' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  customerName?: string;

  @ApiPropertyOptional({ example: '+62 812-3456-7890' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  customerPhone?: string;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES, description: "Default 'Belum Dibayar'" })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  paymentStatus?: (typeof PAYMENT_STATUSES)[number];

  @ApiPropertyOptional({
    description:
      'Acknowledge that this plate already has a rental over the same dates ' +
      '(e.g. a second booking the same day). Absent/false ⇒ the overlap is ' +
      'refused with CONFLICT and one `plateOverlap` detail per clashing rental.',
  })
  @IsOptional()
  @IsBoolean()
  allowOverlap?: boolean;

  @ApiPropertyOptional({
    description:
      'Charge PPN on this transaction. Default true. Only takes effect while the ' +
      'partner is a PKP — a non-PKP partner never charges PPN regardless. Set ' +
      'false for a sale outside the scope of VAT. Cannot change once the rental ' +
      'is Sudah Dibayar (CONFLICT); revert the payment status first.',
  })
  @IsOptional()
  @IsBoolean()
  applyPpn?: boolean;

  @ApiPropertyOptional({
    type: [Number],
    example: [12, 13],
    description:
      'Confirmed proof ids to attach to this rental. Required when paymentStatus is Sudah Dibayar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RENTAL_MAX_PROOFS)
  @Type(() => Number)
  @IsInt({ each: true })
  paymentProofIds?: number[];
}
