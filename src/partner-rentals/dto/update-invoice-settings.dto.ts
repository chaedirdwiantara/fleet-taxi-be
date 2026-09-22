import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The officer who signs the partner's rental invoices. Both fields are
 * optional and an empty string clears them — the invoice then falls back to
 * signing as the partner itself.
 */
export class UpdateInvoiceSettingsDto {
  @ApiPropertyOptional({
    description: 'Printed under the signature; empty falls back to the partner name',
    example: 'M Rizki',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  signatoryName?: string;

  @ApiPropertyOptional({
    description: 'Printed under the name, e.g. the job title',
    example: 'Head of Rental Operations PT JGS',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  signatoryTitle?: string;
}
