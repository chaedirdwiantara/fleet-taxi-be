import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** Upsert one per-partner default COGS/day row ("Setting COGS"). */
export class UpsertCogsDefaultDto {
  @ApiPropertyOptional({
    example: 'air_ev',
    description: 'Present → update that row; absent → create (key slugified from label)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  key?: string;

  @ApiProperty({ example: 'Air EV' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @ApiProperty({ example: 335833, description: 'Integer rupiah' })
  @IsInt()
  @Min(0)
  cogsPerDay!: number;
}
