import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './partners';

// Redesigned from legacy trx_orders (PROJECT-BRIEF.md §5)
export const orders = pgTable(
  'orders',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orderNumber: text('order_number').notNull().unique(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id), // data-scoping key
    orderType: text('order_type'), // e.g. "later"
    tripStatus: text('trip_status'), // draft | submitted | ...
    pickupCode: text('pickup_code'),
    destinationCode: text('destination_code'),
    carTypesId: bigint('car_types_id', { mode: 'number' }),
    pickupAt: timestamp('pickup_at', { withTimezone: true }),
    basicPrice: bigint('basic_price', { mode: 'number' }), // integer rupiah
    refHotelId: bigint('ref_hotel_id', { mode: 'number' }),
    passengerDetails: jsonb('passenger_details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('orders_partner_id_idx').on(t.partnerId),
    index('orders_trip_status_idx').on(t.tripStatus),
  ],
);
