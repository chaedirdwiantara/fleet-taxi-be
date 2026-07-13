import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { PAYMENT_STATUSES } from '../rental-presenter';

export class UpdatePaymentStatusDto {
  @ApiProperty({ enum: PAYMENT_STATUSES, example: 'Sudah Dibayar' })
  @IsIn(PAYMENT_STATUSES)
  paymentStatus!: (typeof PAYMENT_STATUSES)[number];
}
