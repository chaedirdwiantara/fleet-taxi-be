import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreatePartnerOrderDto {
  @ApiProperty({ example: 'BHISA_CAWANG', description: 'Pool code (whitelisted)' })
  @IsString()
  @MinLength(1)
  pickupCode!: string;

  @ApiProperty({ example: 'EVISTA_HALIM' })
  @IsString()
  @MinLength(1)
  destinationCode!: string;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  carTypesId!: number;

  @ApiProperty({
    example: '2026-07-10 09:00:00',
    description: 'ISO 8601, or "YYYY-MM-DD HH:mm:ss" interpreted as Asia/Jakarta',
  })
  @IsString()
  @MinLength(10)
  pickupAt!: string;

  @ApiPropertyOptional({ description: 'Free-form passenger details (stored as JSON)' })
  @IsOptional()
  passengerDetails?: unknown;
}
