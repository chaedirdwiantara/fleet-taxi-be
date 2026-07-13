import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DRIVER_DECISION_ACTIONS, DriverDecisionAction } from '../driver.constants';

/** Deposit / deposit-return decision. */
export class DriverDecisionDto {
  @ApiProperty({ enum: DRIVER_DECISION_ACTIONS, example: 'approve' })
  @IsIn(DRIVER_DECISION_ACTIONS)
  action!: DriverDecisionAction;

  @ApiPropertyOptional({ example: 'Nominal tidak sesuai', description: 'Catatan (saat menolak)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Final registration verification decision. */
export class VerifyDriverRegistrationDto {
  @ApiProperty({ enum: DRIVER_DECISION_ACTIONS, example: 'approve' })
  @IsIn(DRIVER_DECISION_ACTIONS)
  action!: DriverDecisionAction;

  @ApiPropertyOptional({ example: 'Dokumen tidak jelas', description: 'Alasan penolakan' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectNote?: string;
}
