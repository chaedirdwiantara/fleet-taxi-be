import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { partners } from './partners';

/**
 * Rental Monitoring (port of legacy admin/jadwal-mobil-cogs into the partner
 * portal). One row = one rental transaction of a partner's vehicle over an
 * inclusive [start_date, end_date] range. All money columns are integer
 * rupiah (PROJECT-BRIEF.md §7) — never floats, never strings.
 */
export const rentals = pgTable(
  'rentals',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    plateNumber: text('plate_number').notNull(), // display, as entered
    plateNumberNorm: text('plate_number_norm').notNull(), // normalized [A-Z0-9]
    vehicleType: text('vehicle_type'),
    region: text('region'),
    startDate: date('start_date').notNull(), // inclusive
    endDate: date('end_date').notNull(), // inclusive
    pricePerDay: bigint('price_per_day', { mode: 'number' }).notNull(), // integer rupiah
    cogsPerDay: bigint('cogs_per_day', { mode: 'number' }).notNull().default(0),
    cogsType: text('cogs_type'),
    // TOTAL for the transaction (NOT per day) — counted once in monthly figures.
    additionalCost: bigint('additional_cost', { mode: 'number' }).notNull().default(0),
    additionalCostDescription: text('additional_cost_description'),
    deposit: bigint('deposit', { mode: 'number' }).notNull().default(0),
    rentalType: text('rental_type'), // 'Dengan Driver' | 'Lepas Kunci'
    infoSource: text('info_source'),
    serviceArea: text('service_area'),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    paymentStatus: text('payment_status').notNull().default('Belum Dibayar'), // | 'Sudah Dibayar'
    /**
     * VAT rate in basis points, CAPTURED AT WRITE TIME from the partner's PKP
     * status (1100 = 11%, 0 = not taxed). Stored per row rather than read from
     * a constant so a rate change — or a partner becoming PKP — never rewrites
     * what past invoices already billed. The rupiah amount stays derived, like
     * every other money figure here.
     */
    ppnRateBps: integer('ppn_rate_bps').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rentals_partner_id_idx').on(t.partnerId),
    index('rentals_partner_start_date_idx').on(t.partnerId, t.startDate),
    index('rentals_partner_plate_norm_idx').on(t.partnerId, t.plateNumberNorm),
  ],
);

/**
 * Payment evidence for a rental (images/PDFs of the transfer receipt). A
 * rental may only be marked 'Sudah Dibayar' while it carries at least one
 * uploaded proof, capped at RENTAL_MAX_PROOFS — the money in the monthly
 * recap counts paid rows only, so the status must be defensible.
 *
 * `rental_id` is NULLABLE on purpose: the add-rental form can upload evidence
 * BEFORE the rental row exists, so a proof starts as a partner-owned draft and
 * is attached when the rental is written. `partner_id` is therefore the
 * authorization anchor for the whole lifecycle, not a denormalization.
 *
 * The uploader identity is SNAPSHOTTED (no FK to users, same reasoning as
 * activity_logs): the audit trail must survive account deletion.
 */
export const rentalPaymentProofs = pgTable(
  'rental_payment_proofs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    // NULL ⇒ draft uploaded before its rental existed; set on attach.
    rentalId: bigint('rental_id', { mode: 'number' }).references(() => rentals.id, {
      onDelete: 'cascade',
    }),
    storageKey: text('storage_key').notNull().unique(),
    fileName: text('file_name').notNull(), // original name, display only
    contentType: text('content_type').notNull(), // image/jpeg | image/png | application/pdf
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(), // declared at presign
    status: text('status').notNull().default('pending'), // pending | uploaded
    uploadedByUserId: bigint('uploaded_by_user_id', { mode: 'number' }),
    uploadedByName: text('uploaded_by_name'),
    uploadedByEmail: text('uploaded_by_email').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('rental_payment_proofs_rental_idx').on(t.rentalId),
    // Drives the draft sweep: partner's own unattached rows, oldest first.
    index('rental_payment_proofs_partner_rental_idx').on(t.partnerId, t.rentalId),
  ],
);

/**
 * Per-partner default COGS/day per vehicle-type key ("Setting COGS" in the
 * legacy page). Lazy-seeded with the legacy defaults on first read.
 */
export const rentalCogsDefaults = pgTable(
  'rental_cogs_defaults',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    vehicleTypeKey: text('vehicle_type_key').notNull(), // slug, e.g. "air_ev"
    vehicleTypeLabel: text('vehicle_type_label').notNull(), // display, e.g. "Air EV"
    cogsPerDay: bigint('cogs_per_day', { mode: 'number' }).notNull().default(0), // integer rupiah
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('rental_cogs_defaults_partner_key_uq').on(t.partnerId, t.vehicleTypeKey)],
);
