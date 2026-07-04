import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const partners = pgTable('partners', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  code: text('code').notNull().unique(), // e.g. BHISA, HOTEL_X
  name: text('name').notNull(),
  type: text('type'), // shuttle | hotel | ...
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
