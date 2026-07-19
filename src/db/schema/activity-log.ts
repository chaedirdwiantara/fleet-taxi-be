import { bigint, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Audit trail for both console audiences (admin + partner portal).
 * Deliberately no FK to users: logs must survive account deletion, so the
 * actor identity is snapshotted into actor_email / actor_name at write time.
 */
export const activityLogs = pgTable(
  'activity_logs',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    audience: text('audience').notNull(), // admin | partner
    // null for failed logins (no authenticated account)
    actorId: bigint('actor_id', { mode: 'number' }),
    actorEmail: text('actor_email').notNull(), // attempted email on login failure
    actorName: text('actor_name'),
    partnerId: bigint('partner_id', { mode: 'number' }),
    // auth.login.success | auth.login.failure | auth.logout |
    // auth.password_change | mutation.create | mutation.update | mutation.delete
    action: text('action').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    // route params only — never request bodies (they can contain passwords)
    resourceSummary: text('resource_summary'),
    status: text('status').notNull(), // success | failure
    statusCode: integer('status_code'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_activity_logs_created_at').on(t.createdAt.desc()),
    index('idx_activity_logs_audience_created_at').on(t.audience, t.createdAt.desc()),
    index('idx_activity_logs_actor_email').on(t.actorEmail),
  ],
);
