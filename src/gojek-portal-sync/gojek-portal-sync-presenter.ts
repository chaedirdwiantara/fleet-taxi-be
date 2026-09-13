import type { gojekPortalSyncRuns, gojekPortalSyncSettings } from '../db/schema';
import { SyncStatus, SyncTrigger } from './sync-schedule';

type SettingsRow = typeof gojekPortalSyncSettings.$inferSelect;
type RunRow = typeof gojekPortalSyncRuns.$inferSelect;

/** Settings as the console sees them — the credential digest never leaves the server. */
export interface GojekPortalSyncSettingsDto {
  email: string | null;
  /** A password is on file (its value is never returned). */
  hasPassword: boolean;
  isEnabled: boolean;
  runAt: string;
  lookbackDays: number;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
  /** GOJEK_PORTAL_ENCRYPTION_KEY is registered on the server. */
  encryptionConfigured: boolean;
}

export interface GojekPortalSyncRunDto {
  id: number;
  trigger: SyncTrigger;
  status: SyncStatus;
  dateFrom: string;
  dateTo: string;
  reportId: number | null;
  filename: string | null;
  importedRows: number | null;
  skippedRows: number | null;
  importIds: number[];
  message: string | null;
  triggeredBy: number | null;
  triggeredByName: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface GojekPortalSyncStatusDto {
  isEnabled: boolean;
  /** Account + password on file. */
  hasCredentials: boolean;
  encryptionConfigured: boolean;
  lastVerifiedAt: string | null;
  lastSuccess: GojekPortalSyncRunDto | null;
  lastRun: GojekPortalSyncRunDto | null;
  runningRun: GojekPortalSyncRunDto | null;
  /** Scheduled attempts already made today (WIB). */
  todayScheduledAttempts: number;
  /** Next tick that may start a scheduled run; null when the schedule is off. */
  nextScheduledAt: string | null;
}

export function toSettingsDto(
  row: SettingsRow | null,
  encryptionConfigured: boolean,
  updatedByName: string | null,
): GojekPortalSyncSettingsDto {
  return {
    email: row?.email ?? null,
    hasPassword: !!row?.passwordDigestEnc,
    isEnabled: row?.isEnabled ?? false,
    runAt: row?.runAt ?? '05:00',
    lookbackDays: row?.lookbackDays ?? 1,
    lastVerifiedAt: row?.lastVerifiedAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedByName,
    encryptionConfigured,
  };
}

export function toRunDto(row: RunRow, triggeredByName: string | null): GojekPortalSyncRunDto {
  return {
    id: row.id,
    trigger: row.trigger as SyncTrigger,
    status: row.status as SyncStatus,
    dateFrom: row.dateFrom,
    dateTo: row.dateTo,
    reportId: row.reportId,
    filename: row.filename,
    importedRows: row.importedRows,
    skippedRows: row.skippedRows,
    importIds: row.importIds ?? [],
    message: row.message,
    triggeredBy: row.triggeredBy,
    triggeredByName,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
