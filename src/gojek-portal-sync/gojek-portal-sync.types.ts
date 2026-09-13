/**
 * e2e specs boot many Nest apps against ONE Redis; a per-process name keeps a
 * sibling spec's worker (wired to the REAL portal client) from picking up a
 * run that this spec's fake portal was meant to serve.
 */
export const GOJEK_PORTAL_SYNC_QUEUE =
  process.env.NODE_ENV === 'test' ? `gojek-portal-sync-test-${process.pid}` : 'gojek-portal-sync';

/** Repeatable job id — one per deployment, upserted on boot (idempotent across instances). */
export const GOJEK_PORTAL_SYNC_TICK_ID = 'gojek-portal-sync-tick';
export const GOJEK_PORTAL_SYNC_TICK_EVERY_MS = 30 * 60 * 1000;

export interface SyncRunJobData {
  runId: number;
}
