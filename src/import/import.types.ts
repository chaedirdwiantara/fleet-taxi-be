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
  /**
   * Portal pulls only (gojek-portal-sync): keep just the rows whose
   * transaction date falls inside this WIB window (YYYY-MM-DD, inclusive) —
   * a pull that straddles two months becomes one job per month.
   */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Portal pulls only: skip a row when the same period already holds an
   * identical row (any batch), so overlapping lookback windows and daily
   * re-pulls never double-count a deposit. Manual uploads keep the legacy
   * behaviour (every row is inserted).
   */
  dedupe?: boolean;
}

export interface RollbackJobData {
  platform: Platform;
  importId: number;
  periodYear: number;
  periodMonth: number;
}
