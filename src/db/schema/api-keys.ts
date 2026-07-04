import { bigint, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './partners';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(), // argon2(raw key, secret: API_KEY_PEPPER); raw shown once
    keyPrefix: text('key_prefix').notNull(), // short non-secret prefix for O(1) lookup/display
    label: text('label'),
    scopes: text('scopes').array().notNull().default([]), // e.g. {pricelist, order:create, order:read}
    rateLimit: integer('rate_limit'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_key_prefix_idx').on(t.keyPrefix)],
);
