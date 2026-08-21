import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { DriverMasterDataDto } from './driver-master-data.dto';

/**
 * Partial edit of a driver on the edit page: master data (completeness filled
 * in after the fleet sync — or the manual registration — created the row) plus
 * the lifecycle toggles (resigned / depositReturned). Rows are never deleted;
 * `exitedAt` is derived by the sync and deliberately not writable here.
 */
export class UpdateDriverDto extends DriverMasterDataDto {
  @ApiPropertyOptional({ example: 'Budi Santoso' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

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
