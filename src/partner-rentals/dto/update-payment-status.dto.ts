import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional } from 'class-validator';
import { PAYMENT_STATUSES } from '../rental-presenter';
import { RENTAL_MAX_PROOFS } from '../rental-proof.constants';

export class UpdatePaymentStatusDto {
  @ApiProperty({ enum: PAYMENT_STATUSES, example: 'Sudah Dibayar' })
  @IsIn(PAYMENT_STATUSES)
  paymentStatus!: (typeof PAYMENT_STATUSES)[number];

  @ApiPropertyOptional({
    type: [Number],
    example: [12, 13],
    description:
      'Confirmed proof ids to attach. Required (together with any already-attached proof) when setting Sudah Dibayar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(RENTAL_MAX_PROOFS)
  @Type(() => Number)
  @IsInt({ each: true })
  paymentProofIds?: number[];
}
