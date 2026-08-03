import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Admin "Plate Registration" — same two fields as the partner portal: nomor + Type. */
export class AdminPlateDto {
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

  @ApiPropertyOptional({
    example: 'Bhisa Shuttle',
    description:
      'Nama partner, teks bebas. Kosongkan untuk memakai partner yang mendaftarkan plat yang sama di portalnya.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  partnerName?: string;
}
