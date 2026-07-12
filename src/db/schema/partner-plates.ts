import { bigint, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { partners } from './partners';

/**
 * Plates a partner registers for itself ("Daftarkan Plat", legacy /partner/plates:
 * fields = nomor + Type). This is the ONLY source of truth for fleet scoping:
 * the Gojek/Grab grids a partner sees are filtered to its own normalized plates
 * here — never to anything the client sends — and the ADMIN Gojek fleet
 * monitoring is scoped to the union of every partner's registrations.
 */
export const partnerPlates = pgTable(
  'partner_plates',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    plateNumber: text('plate_number').notNull(), // display, as entered (e.g. "B 1793 SCP")
    plateNumberNorm: text('plate_number_norm').notNull(), // normalized [A-Z0-9], scoping/uniqueness key
    vehicleType: text('vehicle_type'), // legacy "Type", free text (e.g. "Premium - BYD M6")
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('partner_plates_partner_plate_uq').on(t.partnerId, t.plateNumberNorm),
    index('partner_plates_partner_id_idx').on(t.partnerId),
  ],
);
