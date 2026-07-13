import { PartialType } from '@nestjs/swagger';
import { CreateDriverRegistrationDto } from './create-driver-registration.dto';

/** Partial edit of a registration's master data (pending/rejected only). */
export class UpdateDriverRegistrationDto extends PartialType(CreateDriverRegistrationDto) {}
