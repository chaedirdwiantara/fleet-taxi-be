export const IMPORT_QUEUE = 'fleet-import';

export type Platform = 'gojek' | 'grab';

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
