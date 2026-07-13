import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Partial edit of a driver on the edit page: master data (completeness filled
 * in manually after the fleet sync creates the row) plus lifecycle toggles
 * (resigned / depositReturned). There is no create/delete endpoint — rows are
 * created by the fleet sync only.
 */
export class UpdateDriverDto {
  @ApiPropertyOptional({ example: 'Budi Santoso' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'budi@example.com' })
  @IsOptional()
  @ValidateIf((o: UpdateDriverDto) => o.email !== '') // '' clears the field
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '0812xxxxxxx' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'Jl. Melati No. 1, Jakarta Selatan' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

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
  @ValidateIf((o: UpdateDriverDto) => o.simExpired !== '') // '' clears the field
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

  @ApiPropertyOptional({
    example: false,
    description: 'true = tandai resign (nonaktif); false = batalkan resign',
  })
  @IsOptional()
  @IsBoolean()
  resigned?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'Hanya untuk driver resign: true = deposit sudah dikembalikan (butuh bukti terunggah)',
  })
  @IsOptional()
  @IsBoolean()
  depositReturned?: boolean;
}
