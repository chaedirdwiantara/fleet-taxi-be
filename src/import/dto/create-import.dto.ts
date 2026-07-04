import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class CreateImportDto {
  @ApiProperty({ minimum: 1, maximum: 12, example: 7 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty({ minimum: 2020, maximum: 2099, example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2099)
  year!: number;
}
