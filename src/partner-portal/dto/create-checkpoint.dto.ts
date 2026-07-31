import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { HANDOVER_TYPES, HandoverType } from '../checkpoint.constants';

export class CreateCheckpointDto {
  @ApiProperty({ example: 'B 1793 SCP', description: 'Nomor plat (must be a registered plate)' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  plateNumber!: string;

  @ApiProperty({ enum: HANDOVER_TYPES, example: 'delivery_to_customer' })
  @IsIn(HANDOVER_TYPES)
  handoverType!: HandoverType;

  @ApiPropertyOptional({
    example: 'Andi Pratama',
    description: 'Nama petugas partner — penyerah on a delivery, penerima on a return',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  partnerStaffName?: string;

  @ApiPropertyOptional({
    example: 'Budi Santoso',
    description:
      'Nama pihak eksternal (customer/driver) — penerima on a delivery, penyerah on a return',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  counterpartName?: string;

  @ApiPropertyOptional({ example: '0812xxxxxxx' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  counterpartPhone?: string;
}
