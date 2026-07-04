import { ApiProperty } from '@nestjs/swagger';

export class PageMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 50 })
  pageSize!: number;

  @ApiProperty({ example: 320 })
  total!: number;
}

/**
 * Controllers return this shape for paginated lists; the response-envelope
 * interceptor passes `data` and `meta` through into the standard envelope.
 */
export interface Paginated<T> {
  data: T[];
  meta: PageMetaDto;
}
