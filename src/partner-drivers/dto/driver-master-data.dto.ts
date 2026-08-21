import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Master data of a driver, every field optional — shared verbatim by
 * CreateDriverDto (manual registration) and UpdateDriverDto (completing a row
 * the fleet sync created). Only `name` and the lifecycle toggles differ between
 * the two, so they live in the subclasses.
 *
 * Empty strings clear a text field; `null` clears a coordinate.
 */
export class DriverMasterDataDto {
  @ApiPropertyOptional({ example: 'budi@example.com' })
  @IsOptional()
  @ValidateIf((o: DriverMasterDataDto) => o.email !== '') // '' clears the field
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '0812xxxxxxx' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({
    example: 'Jl. Melati No. 1, Jakarta Selatan',
    description: 'Alamat rumah hasil survey',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  // `type` + `nullable` are explicit: this project runs @nestjs/swagger WITHOUT
  // the CLI plugin, so a `number | null` union reflects as `Object` and the
  // generated FE client loses the number type.
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: -6.229728,
    description: 'Lintang titik rumah (WGS84). Kirim null untuk menghapus titik.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  homeLat?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 106.689399,
    description: 'Bujur titik rumah (WGS84). Kirim null untuk menghapus titik.',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  homeLng?: number | null;

  @ApiPropertyOptional({ example: '3174xxxxxxxxxxxx', description: 'Nomor KTP' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  ktpNo?: string;

  @ApiPropertyOptional({ example: '1234-5678-901234', description: 'Nomor SIM' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  simNo?: string;

  @ApiPropertyOptional({ example: '2027-03-15', description: 'Masa berlaku SIM (YYYY-MM-DD)' })
  @IsOptional()
  @ValidateIf((o: DriverMasterDataDto) => o.simExpired !== '') // '' clears the field
  @IsISO8601({ strict: true })
  simExpired?: string;

  @ApiPropertyOptional({
    example: 'B 1793 SCP',
    description: 'Plat unit yang dioperasikan (harus plat terdaftar partner)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  plateNumber?: string;

  @ApiPropertyOptional({ example: 'BCA 1234567890 a.n. Budi', description: 'Rekening driver' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankAccount?: string;

  @ApiPropertyOptional({ example: 2500000, description: 'Deposit (rupiah bulat)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositAmount?: number;

  @ApiPropertyOptional({ example: true, description: 'Aktif/nonaktifkan driver' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
