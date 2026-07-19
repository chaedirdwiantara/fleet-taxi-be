import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Create/update a Cicilan Deposit rule (legacy Evista "Income Cuts" port). */
export class CreateDepositInstallmentDto {
  @ApiProperty({ example: 'Cicilan Deposit Driver Halim' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  title!: string;

  @ApiProperty({ example: 'YULIUS BAMBANG TRIUTOMO', description: 'From /driver-options' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  driverName!: string;

  @ApiProperty({ example: 25000, description: 'Integer rupiah per cicilan' })
  @IsInt()
  @Min(1)
  installmentAmount!: number;

  @ApiProperty({ example: 20, description: 'Durasi: jumlah cicilan (Nx)' })
  @IsInt()
  @Min(1)
  @Max(999)
  installmentCount!: number;

  @ApiPropertyOptional({
    example: 100000,
    description:
      'Cicilan hanya berlaku pada hari aktif dengan setoran >= nilai ini (inklusif). Kosong = semua hari aktif.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minDailySetoran?: number;

  @ApiProperty({ example: '2026-07-01', description: 'YYYY-MM-DD, tanggal mulai berlaku' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'effectiveDate must be YYYY-MM-DD' })
  effectiveDate!: string;

  @ApiPropertyOptional({ example: 'Deposit 500.000' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
