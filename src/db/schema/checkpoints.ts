import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { partners } from './partners';
import { users } from './users';

/**
 * Vehicle-handover inspection ("Checkpoint"). A partner user documents the
 * handover of a unit (delivery to / return from a customer or driver): per
 * inspection point photos + pass/fail + note, plus odometer, battery level,
 * both parties' signatures and a generated PDF report.
 *
 * The plate is stored as text (not an FK to partner_plates) on purpose:
 * deleting a registered plate must never destroy inspection history. The
 * allowlist is enforced at creation time only.
 */
export const checkpoints = pgTable(
  'checkpoints',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    createdBy: bigint('created_by', { mode: 'number' })
      .notNull()
      .references(() => users.id),
    plateNumber: text('plate_number').notNull(), // display, as entered
    plateNumberNorm: text('plate_number_norm').notNull(), // normalized [A-Z0-9]
    // delivery_to_customer | return_from_customer | delivery_to_driver | return_from_driver
    handoverType: text('handover_type').notNull(),
    status: text('status').notNull().default('draft'), // draft | completed
    counterpartName: text('counterpart_name'),
    counterpartPhone: text('counterpart_phone'),
    odometerKm: integer('odometer_km'), // required at completion
    batteryPercent: smallint('battery_percent'), // 0..100, required at completion
    generalNotes: text('general_notes'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('checkpoints_partner_created_idx').on(t.partnerId, t.createdAt.desc()),
    // serves the previous-checkpoint (comparison) lookup
    index('checkpoints_prev_lookup_idx').on(
      t.partnerId,
      t.plateNumberNorm,
      t.handoverType,
      t.completedAt.desc(),
    ),
  ],
);

/**
 * One row per inspection point of the fixed template (seeded on checkpoint
 * creation). `passed = NULL` means not inspected yet.
 */
export const checkpointPoints = pgTable(
  'checkpoint_points',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    checkpointId: bigint('checkpoint_id', { mode: 'number' })
      .notNull()
      .references(() => checkpoints.id, { onDelete: 'cascade' }),
    pointKey: text('point_key').notNull(), // stable enum key (checkpoint.constants.ts)
    passed: boolean('passed'), // NULL = belum diperiksa
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('checkpoint_points_checkpoint_point_uq').on(t.checkpointId, t.pointKey)],
);

/**
 * Photos (per point) and signatures (checkpoint-level, pointId NULL).
 * Rows start `pending` (presigned URL issued) and become `uploaded` once the
 * client confirms; completion validation counts only uploaded media.
 */
export const checkpointMedia = pgTable(
  'checkpoint_media',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    checkpointId: bigint('checkpoint_id', { mode: 'number' })
      .notNull()
      .references(() => checkpoints.id, { onDelete: 'cascade' }),
    pointId: bigint('point_id', { mode: 'number' }).references(() => checkpointPoints.id, {
      onDelete: 'cascade',
    }), // NULL ⇒ checkpoint-level (signatures)
    kind: text('kind').notNull(), // photo | signature_partner | signature_counterpart
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(), // image/jpeg | image/png
    sizeBytes: integer('size_bytes').notNull(), // declared at presign
    status: text('status').notNull().default('pending'), // pending | uploaded
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('checkpoint_media_checkpoint_idx').on(t.checkpointId),
    index('checkpoint_media_point_idx').on(t.pointId),
  ],
);
