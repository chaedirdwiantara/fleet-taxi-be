import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { DriverMasterDataDto } from './driver-master-data.dto';

/**
 * Manual driver registration — for drivers who are not (yet) in the Gojek/Grab
 * import: a new hire, a rental-only driver, or someone the import spells
 * differently. The row lands with `source: 'manual'` and is otherwise identical
 * to a synced one, so the edit page, documents and the resign lifecycle all
 * work unchanged.
 *
 * Only the name is required — the rest is completed on the edit page, mirroring
 * how a synced row starts out sparse.
 */
export class CreateDriverDto extends DriverMasterDataDto {
  @ApiProperty({ example: 'Budi Santoso' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
