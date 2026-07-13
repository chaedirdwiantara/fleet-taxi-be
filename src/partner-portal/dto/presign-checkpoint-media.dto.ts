import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  CHECKPOINT_MAX_MEDIA_BYTES,
  CHECKPOINT_MEDIA_CONTENT_TYPES,
  CHECKPOINT_MEDIA_KINDS,
  CHECKPOINT_POINT_KEYS,
  CheckpointMediaKind,
  CheckpointPointKey,
} from '../checkpoint.constants';

export class PresignCheckpointMediaDto {
  @ApiProperty({ enum: CHECKPOINT_MEDIA_KINDS, example: 'photo' })
  @IsIn(CHECKPOINT_MEDIA_KINDS)
  kind!: CheckpointMediaKind;

  @ApiPropertyOptional({
    enum: CHECKPOINT_POINT_KEYS,
    description: 'Required for kind=photo, forbidden for signatures',
  })
  @IsOptional()
  @IsIn(CHECKPOINT_POINT_KEYS)
  pointKey?: CheckpointPointKey;

  @ApiProperty({ enum: CHECKPOINT_MEDIA_CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(CHECKPOINT_MEDIA_CONTENT_TYPES)
  contentType!: string;

  @ApiProperty({ example: 350_000, description: `Bytes, max ${CHECKPOINT_MAX_MEDIA_BYTES}` })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CHECKPOINT_MAX_MEDIA_BYTES)
  sizeBytes!: number;
}
