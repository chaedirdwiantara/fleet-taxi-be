import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  RENTAL_MAX_PROOF_BYTES,
  RENTAL_PROOF_CONTENT_TYPES,
  RentalProofContentType,
} from '../rental-proof.constants';

/** Declares one payment-evidence upload; the response carries the upload URL. */
export class PresignRentalProofDto {
  @ApiProperty({ enum: RENTAL_PROOF_CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(RENTAL_PROOF_CONTENT_TYPES)
  contentType!: RentalProofContentType;

  @ApiProperty({ example: 350_000, description: `Bytes, max ${RENTAL_MAX_PROOF_BYTES}` })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RENTAL_MAX_PROOF_BYTES)
  sizeBytes!: number;

  @ApiProperty({ example: 'bukti-transfer.jpg', description: 'Original file name (display only)' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;
}
