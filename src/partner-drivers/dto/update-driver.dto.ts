import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateDriverRegistrationDto } from './create-driver-registration.dto';

/** Partial edit of an active driver's master data; may also toggle isActive. */
export class UpdateDriverDto extends PartialType(CreateDriverRegistrationDto) {
  @ApiPropertyOptional({ example: true, description: 'Aktif/nonaktifkan driver' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
