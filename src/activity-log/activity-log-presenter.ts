/**
 * Presentation layer for activity logs — maps DB rows → the API shape the
 * admin console consumes. Display-only.
 */
import type { activityLogs } from '../db/schema/activity-log';

export type ActivityLogRow = typeof activityLogs.$inferSelect;

export interface ActivityLogDto {
  id: number;
  audience: 'admin' | 'partner';
  actorId: number | null;
  actorEmail: string;
  actorName: string | null;
  partnerId: number | null;
  action: string;
  method: string;
  path: string;
  resourceSummary: string | null;
  status: 'success' | 'failure';
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

export function toActivityLog(row: ActivityLogRow): ActivityLogDto {
  return {
    id: row.id,
    audience: row.audience as ActivityLogDto['audience'],
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    actorName: row.actorName,
    partnerId: row.partnerId,
    action: row.action,
    method: row.method,
    path: row.path,
    resourceSummary: row.resourceSummary,
    status: row.status as ActivityLogDto['status'],
    statusCode: row.statusCode,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}
