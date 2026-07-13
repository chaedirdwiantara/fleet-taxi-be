import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import {
  DRIVER_DOCUMENT_CONTENT_TYPES,
  DRIVER_DOCUMENT_KINDS,
  DRIVER_MAX_DOCUMENT_BYTES,
  DriverDocumentContentType,
  DriverDocumentKind,
} from '../driver.constants';

export class PresignDriverDocumentDto {
  @ApiProperty({ enum: DRIVER_DOCUMENT_KINDS, example: 'ktp' })
  @IsIn(DRIVER_DOCUMENT_KINDS)
  kind!: DriverDocumentKind;

  @ApiProperty({ enum: DRIVER_DOCUMENT_CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(DRIVER_DOCUMENT_CONTENT_TYPES)
  contentType!: DriverDocumentContentType;

  @ApiProperty({ example: 350_000, description: `Bytes, max ${DRIVER_MAX_DOCUMENT_BYTES}` })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DRIVER_MAX_DOCUMENT_BYTES)
  sizeBytes!: number;
}
