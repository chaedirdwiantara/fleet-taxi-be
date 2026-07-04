import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';

export const fleetImports = pgTable('fleet_imports', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  filename: text('filename'),
  periodMonth: integer('period_month').notNull(), // 1..12
  periodYear: integer('period_year').notNull(),
  importedBy: bigint('imported_by', { mode: 'number' }).references(() => users.id),
  status: text('status').notNull().default('pending'), // pending|processing|done|failed
  totalRows: integer('total_rows').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fleetTargets = pgTable('fleet_targets', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  vehiclePlate: text('vehicle_plate').notNull().unique(),
  vehiclePlateNorm: text('vehicle_plate_norm').notNull(),
  vehicleType: text('vehicle_type'),
  fleetTarget: bigint('fleet_target', { mode: 'number' }), // integer rupiah daily target
  rentalPartner: text('rental_partner'),
  deliveryBatch: text('delivery_batch'),
  serviceArea: text('service_area'),
  regionId: bigint('region_id', { mode: 'number' }), // FK to future regions/pickup-points table
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fleetExceptions = pgTable(
  'fleet_exceptions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    vehiclePlate: text('vehicle_plate').notNull(),
    exceptionDate: date('exception_date').notNull(), // legacy "tanggal"
    keterangan: text('keterangan'),
    isBebasSetoran: boolean('is_bebas_setoran').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('fleet_exceptions_vehicle_plate_idx').on(t.vehiclePlate),
    index('fleet_exceptions_exception_date_idx').on(t.exceptionDate),
  ],
);
