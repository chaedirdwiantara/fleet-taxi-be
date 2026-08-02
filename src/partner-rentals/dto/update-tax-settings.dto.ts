import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * A partner's VAT posture. Only a PKP may charge PPN, so this single flag is
 * what turns tax on for every rental written afterwards.
 */
export class UpdateTaxSettingsDto {
  @ApiProperty({
    description: 'Pengusaha Kena Pajak — true enables PPN on new rental transactions',
    example: true,
  })
  @IsBoolean()
  isPkp!: boolean;

  @ApiPropertyOptional({
    description: 'NPWP printed on invoices; digits/dots/dashes, empty clears it',
    example: '01.234.567.8-901.000',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9.\-\s]*$/, { message: 'NPWP hanya boleh berisi angka, titik, dan strip.' })
  npwp?: string;
}
