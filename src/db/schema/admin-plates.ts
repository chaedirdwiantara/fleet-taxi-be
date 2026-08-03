import { bigint, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Plates the ADMIN console registers for itself ("Plate Registration"). Same
 * fields as partner_plates (nomor + Type) but with no owner: this is the single
 * global registry of the admin console, so the norm is unique across the table.
 *
 * It exists because the admin Gojek monitoring is scoped to registered plates
 * only — before this table a vehicle no partner had registered was invisible to
 * the admin even though its rows sat in fleet_import_details. Registering it
 * here adds it to the admin scope (see RegisteredPlatesService.unionScope).
 *
 * A DELIBERATELY separate table, not a nullable partner_id on partner_plates:
 * every partner-facing query filters `partner_id = :sessionPartnerId`, so admin
 * rows can never leak into a partner's view. A partner only ever sees a plate
 * it registered itself.
 */
export const adminPlates = pgTable(
  'admin_plates',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    plateNumber: text('plate_number').notNull(), // display, as entered (e.g. "B 1793 SCP")
    plateNumberNorm: text('plate_number_norm').notNull(), // normalized [A-Z0-9], scoping/uniqueness key
    vehicleType: text('vehicle_type'), // legacy "Type", free text (e.g. "Premium - BYD M6")
    // Partner label the admin types in. Free text on purpose: an admin often
    // registers a plate before (or without) the operator ever having a portal
    // account, so this cannot be an FK. When empty, the read model falls back to
    // the partner that registered the same plate in its own portal.
    partnerName: text('partner_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('admin_plates_plate_norm_uq').on(t.plateNumberNorm)],
);
