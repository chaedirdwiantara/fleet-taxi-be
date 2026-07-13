import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn } from 'class-validator';
import { DRIVER_CHECKABLE_DOC_KINDS, DriverCheckableDocKind } from '../driver.constants';

export class DriverDocCheckDto {
  @ApiProperty({ enum: DRIVER_CHECKABLE_DOC_KINDS, example: 'ktp' })
  @IsIn(DRIVER_CHECKABLE_DOC_KINDS)
  kind!: DriverCheckableDocKind;

  @ApiProperty({ example: true, description: 'Hasil pemeriksaan dokumen' })
  @IsBoolean()
  verified!: boolean;
}
