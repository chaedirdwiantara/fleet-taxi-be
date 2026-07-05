import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class CreatePartnerDto {
  @ApiProperty({ example: 'BHISA', description: 'Unique partner code (stored uppercase)' })
  @IsString()
  @MinLength(1)
  code!: string;

  @ApiProperty({ example: 'Bhisa Shuttle' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ example: 'shuttle', description: 'shuttle | hotel | ...' })
  @IsOptional()
  @IsString()
  type?: string;
}
