import { bigint, date, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
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
