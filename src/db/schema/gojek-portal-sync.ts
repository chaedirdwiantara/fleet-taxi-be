import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Automatic Gojek report sync from the Fleet Partner Portal
 * (https://fleetpartner.gojek.com). One settings row holds the portal account
 * and daily schedule; every pull (scheduled or manual) is a run.
 *
 * The portal password is NEVER stored: the portal itself only ever receives
 * base64(md5(password)), so we keep that digest, AES-256-GCM encrypted with
 * GOJEK_PORTAL_ENCRYPTION_KEY (see gojek-portal-sync/credential-cipher.ts).
 */
export const gojekPortalSyncSettings = pgTable('gojek_portal_sync_settings', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  email: text('email'),
  passwordDigestEnc: text('password_digest_enc'), // cipher(base64(md5(password)))
  isEnabled: boolean('is_enabled').notNull().default(false),
  runAt: text('run_at').notNull().default('05:00'), // HH:mm WIB, 30-minute steps
  lookbackDays: integer('lookback_days').notNull().default(1), // 1..7
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  updatedBy: bigint('updated_by', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gojekPortalSyncRuns = pgTable(
  'gojek_portal_sync_runs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    trigger: text('trigger').notNull(), // schedule | manual
    status: text('status').notNull(), // running | success | failed
    dateFrom: date('date_from').notNull(), // WIB calendar day
    dateTo: date('date_to').notNull(),
    reportId: bigint('report_id', { mode: 'number' }),
    filename: text('filename'),
    fileKey: text('file_key'),
    importedRows: integer('imported_rows'),
    skippedRows: integer('skipped_rows'),
    importIds: jsonb('import_ids').$type<number[]>(), // fleet_imports.id per period
    message: text('message'),
    triggeredBy: bigint('triggered_by', { mode: 'number' }), // null for the scheduler
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_gojek_portal_sync_runs_started_at').on(t.startedAt.desc()),
    index('idx_gojek_portal_sync_runs_status').on(t.status),
    index('idx_gojek_portal_sync_runs_trigger_started_at').on(t.trigger, t.startedAt.desc()),
  ],
);
