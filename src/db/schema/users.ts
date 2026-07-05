import { bigint, boolean, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { partners } from './partners';

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  fullName: text('full_name'),
  isActive: boolean('is_active').notNull().default(true),
  // true for accounts created by an admin; the user is forced to change their
  // password on first login, which clears this flag.
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  // set for partner-portal users; row-scoping key
  partnerId: bigint('partner_id', { mode: 'number' }).references(() => partners.id),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable('roles', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  name: text('name').notNull().unique(), // super_admin | admin | partner | finance | ...
});

export const userRoles = pgTable(
  'user_roles',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'number' })
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);
