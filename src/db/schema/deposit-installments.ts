import { bigint, date, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './partners';

/**
 * Cicilan Deposit (deposit installment rules) — port of the legacy Evista
 * "Income Cuts" flow into the partner portal. One row = one installment RULE
 * for one driver; the per-installment payment history is NOT stored: it is
 * derived at read time from the driver's active days in fleet_import_details
 * (see deposit-installments/installment-presenter.ts). That makes double
 * counting structurally impossible and keeps history in sync when import
 * months are re-imported. All money columns are integer rupiah
 * (PROJECT-BRIEF.md §7).
 */
export const depositInstallments = pgTable(
  'deposit_installments',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    driverName: text('driver_name').notNull(), // display, as picked
    driverNameNorm: text('driver_name_norm').notNull(), // normalizeDriverName() output; import match key
    installmentAmount: bigint('installment_amount', { mode: 'number' }).notNull(), // integer rupiah per cicilan
    installmentCount: integer('installment_count').notNull(), // durasi: number of installments (Nx)
    // Gate: an active day only produces an installment when that day's setoran
    // paid >= this value (INCLUSIVE). NULL = every active day qualifies.
    minDailySetoran: bigint('min_daily_setoran', { mode: 'number' }),
    effectiveDate: date('effective_date').notNull(), // WIB calendar date, inclusive
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('deposit_installments_partner_created_idx').on(t.partnerId, t.createdAt),
    index('deposit_installments_partner_driver_idx').on(t.partnerId, t.driverNameNorm),
  ],
);
