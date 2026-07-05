import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** "Daftarkan Plat" — legacy /partner/plates fields: nomor + Type. */
export class CreatePlateDto {
  @ApiProperty({ example: 'B 1793 SCP', description: 'Nomor plat (as entered)' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  plateNumber!: string;

  @ApiPropertyOptional({ example: 'Premium - BYD M6', description: 'Type (jenis kendaraan)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vehicleType?: string;
}
