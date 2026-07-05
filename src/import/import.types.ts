import { BadRequestException } from '@nestjs/common';

export const IMPORT_QUEUE = 'fleet-import';

export type Platform = 'gojek' | 'grab';

/** Validates the `:platform` route param. Shared by every platform-scoped controller. */
export function parsePlatform(value: string): Platform {
  if (value === 'gojek' || value === 'grab') return value;
  throw new BadRequestException(`Unknown platform: ${value} (expected gojek|grab)`);
}

export interface ParseJobData {
  platform: Platform;
  importId: number;
  fileKey: string;
  filename: string;
  periodYear: number;
  periodMonth: number;
  kind: 'csv' | 'xlsx';
}

export interface RollbackJobData {
  platform: Platform;
  importId: number;
  periodYear: number;
  periodMonth: number;
}
