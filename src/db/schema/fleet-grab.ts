import { bigint, integer, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const grabImports = pgTable('grab_imports', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  filename: text('filename'),
  periodMonth: integer('period_month').notNull(),
  periodYear: integer('period_year').notNull(),
  totalRow: integer('total_row').default(0),
  importTimeSeconds: numeric('import_time_seconds', { precision: 10, scale: 2 }).default('0'),
  importedBy: bigint('imported_by', { mode: 'number' }).references(() => users.id),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const grabTargets = pgTable('grab_targets', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  plateNumber: text('plate_number').notNull().unique(),
  rentalPartner: text('rental_partner'),
  vehicleType: text('vehicle_type'),
  city: text('city'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
