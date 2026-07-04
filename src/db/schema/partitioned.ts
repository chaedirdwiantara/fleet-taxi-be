/**
 * PARTITIONED tables — deliberately NOT exported from managed.ts, so
 * drizzle-kit never generates DDL for them. Their parent tables are created
 * by the hand-written migration (RANGE partitioned by period_year,
 * period_month) and child partitions by ensureDetailPartition().
 * These definitions exist for typed queries only.
 */
import {
  bigint,
  date,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const fleetImportDetails = pgTable(
  'fleet_import_details',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    importId: bigint('import_id', { mode: 'number' }).notNull(),
    transactionDate: date('transaction_date').notNull(),
    periodYear: integer('period_year').notNull(), // denormalized partition key
    periodMonth: integer('period_month').notNull(),
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    vehiclePlate: text('vehicle_plate'),
    vehiclePlateNorm: text('vehicle_plate_norm'),
    amount: bigint('amount', { mode: 'number' }), // integer rupiah
    type: text('type'), // deduction | due | manual
    isManualPaymentSetoran: smallint('is_manual_payment_setoran'), // 1=counted, 0=uncounted, NULL=n/a
    manualPaymentNote: text('manual_payment_note'),
    referenceId: text('reference_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.periodYear, t.periodMonth] })],
);

export const grabImportDetails = pgTable(
  'grab_import_details',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity(),
    importId: bigint('import_id', { mode: 'number' }).notNull(),
    date: date('date').notNull(),
    periodYear: integer('period_year').notNull(),
    periodMonth: integer('period_month').notNull(),
    plateNumber: text('plate_number'),
    plateNumberNorm: text('plate_number_norm'),
    city: text('city'),
    carModel: text('car_model'),
    driverName: text('driver_name'),
    driverPhoneNumber: text('driver_phone_number'),
    tiering: text('tiering'),
    partnerName: text('partner_name'),
    totalOnlineHours: numeric('total_online_hours', { precision: 10, scale: 2 }),
    totalBookings: integer('total_bookings'),
    totalRides: integer('total_rides'),
    cancelByDriver: integer('cancel_by_driver'),
    fullfilmentRate: numeric('fullfilment_rate', { precision: 10, scale: 2 }),
    driverCancellationRate: numeric('driver_cancellation_rate', { precision: 10, scale: 2 }),
    driverFare: bigint('driver_fare', { mode: 'number' }), // integer rupiah
    tollAndOthers: bigint('toll_and_others', { mode: 'number' }),
    totalIncentive: bigint('total_incentive', { mode: 'number' }),
    totalEarningCollected: bigint('total_earning_collected', { mode: 'number' }),
    compositeKey: text('composite_key'), // plate|city|driver
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.id, t.periodYear, t.periodMonth] })],
);
