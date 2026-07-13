import {
  bigint,
  boolean,
  date,
  index,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { partners } from './partners';

/**
 * Partner-portal driver roster. Rows are SYNCED from the fleet-monitoring
 * import data (Gojek/Grab) keyed by (partner_id, name_norm); manual edits on
 * the driver edit page fill in completeness (documents, deposit, bank, …) and
 * always win over re-syncs. ONE row per driver across the whole lifecycle:
 * active roster → resigned (resigned_at set) → deposit returned.
 *
 * The registration-era columns (registration_status, doc-check flags,
 * deposit decision fields) are deliberately kept — dropping them would be a
 * destructive migration — but are no longer exposed through the API.
 *
 * Deposit amounts are integer rupiah (PROJECT-BRIEF.md §7). The plate is
 * stored as text (not an FK) like checkpoints/rentals: the allowlist is
 * enforced at write time only, so deleting a plate never orphans a driver.
 */
export const drivers = pgTable(
  'drivers',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Sync identity: uppercase, internal whitespace collapsed, trimmed.
    nameNorm: text('name_norm'),
    source: text('source').notNull().default('manual'), // gojek | grab | manual
    email: text('email'),
    phone: text('phone'),
    address: text('address'),
    ktpNo: text('ktp_no'),
    simNo: text('sim_no'),
    simExpired: date('sim_expired'), // 'YYYY-MM-DD'
    driverCode: text('driver_code'), // assigned on approval (DRV-000123)
    plateNumber: text('plate_number'), // display, as entered
    plateNumberNorm: text('plate_number_norm'), // normalized [A-Z0-9]
    bankAccount: text('bank_account'), // rekening pengembalian deposit
    registrationStatus: text('registration_status').notNull().default('pending'), // pending | approved | rejected
    rejectNote: text('reject_note'),
    ktpVerified: boolean('ktp_verified').notNull().default(false),
    simVerified: boolean('sim_verified').notNull().default(false),
    skckVerified: boolean('skck_verified').notNull().default(false),
    depositAmount: bigint('deposit_amount', { mode: 'number' }).notNull().default(0), // integer rupiah
    depositStatus: text('deposit_status').notNull().default('none'), // none | waiting | approved | rejected
    depositNote: text('deposit_note'),
    depositDecidedAt: timestamp('deposit_decided_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    resignedAt: timestamp('resigned_at', { withTimezone: true }), // NULL = not resigned
    depositReturnStatus: text('deposit_return_status').notNull().default('none'), // none | waiting | approved | rejected
    depositReturnDecidedAt: timestamp('deposit_return_decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Postgres allows multiple NULLs, so unapproved drivers don't collide.
    unique('drivers_partner_code_uq').on(t.partnerId, t.driverCode),
    // Sync upsert key: one roster row per normalized driver name per partner.
    unique('drivers_partner_name_norm_uq').on(t.partnerId, t.nameNorm),
    index('drivers_partner_created_idx').on(t.partnerId, t.createdAt.desc()),
    index('drivers_partner_reg_status_idx').on(t.partnerId, t.registrationStatus),
    index('drivers_partner_resigned_idx').on(t.partnerId, t.resignedAt),
  ],
);

/**
 * Driver documents (KTP/SIM/SKCK scans, deposit proofs). Mirrors
 * checkpoint_media: rows start `pending` when a presigned URL is issued and
 * become `uploaded` on confirm; every kind is single-instance, so confirming
 * a new upload replaces the previous document of the same kind.
 */
export const driverDocuments = pgTable(
  'driver_documents',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    driverId: bigint('driver_id', { mode: 'number' })
      .notNull()
      .references(() => drivers.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // ktp | sim | skck | deposit_proof | deposit_return_proof
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(), // image/jpeg | image/png | application/pdf
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(), // declared at presign
    status: text('status').notNull().default('pending'), // pending | uploaded
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('driver_documents_driver_kind_idx').on(t.driverId, t.kind)],
);
