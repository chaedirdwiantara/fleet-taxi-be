import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class SetDriverDepositDto {
  @ApiProperty({ example: 1_500_000, description: 'Nominal deposit (rupiah bulat)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amount!: number;
}
