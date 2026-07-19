import { Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, gte, ilike, lte, or, SQL } from 'drizzle-orm';
import type { Audience } from '../auth/session-audience';
import { Paginated } from '../common/dto/paginated.dto';
import { Pagination } from '../common/util/pagination';
import { DatabaseService } from '../db/database.service';
import { activityLogs } from '../db/schema/activity-log';
import { ActivityLogDto, toActivityLog } from './activity-log-presenter';

/** Canonical action names — the `path` column carries endpoint specificity. */
export const ACTIVITY_ACTIONS = {
  loginSuccess: 'auth.login.success',
  loginFailure: 'auth.login.failure',
  logout: 'auth.logout',
  passwordChange: 'auth.password_change',
  create: 'mutation.create',
  update: 'mutation.update',
  delete: 'mutation.delete',
} as const;

export interface ActivityLogEntry {
  audience: Audience;
  actorId: number | null;
  actorEmail: string;
  actorName?: string | null;
  partnerId?: number | null;
  action: string;
  method: string;
  path: string;
  resourceSummary?: string | null;
  status: 'success' | 'failure';
  statusCode?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface ActivityLogFilters {
  audience?: Audience;
  actor?: string;
  action?: string;
  dateFrom?: string; // ISO date/datetime, inclusive
  dateTo?: string; // ISO date/datetime, inclusive
  search?: string;
}

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * Fire-and-forget audit write: never awaited by callers and never throws —
   * a failed log insert must not fail (or slow down) the business request.
   */
  record(entry: ActivityLogEntry): void {
    void this.database.db
      .insert(activityLogs)
      .values({
        audience: entry.audience,
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        actorName: entry.actorName ?? null,
        partnerId: entry.partnerId ?? null,
        action: entry.action,
        method: entry.method,
        path: entry.path,
        resourceSummary: entry.resourceSummary ?? null,
        status: entry.status,
        statusCode: entry.statusCode ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `activity log write failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  async list(filters: ActivityLogFilters, page: Pagination): Promise<Paginated<ActivityLogDto>> {
    const conds: SQL[] = [];
    if (filters.audience) conds.push(eq(activityLogs.audience, filters.audience));
    if (filters.actor) conds.push(ilike(activityLogs.actorEmail, `%${filters.actor}%`));
    if (filters.action) conds.push(eq(activityLogs.action, filters.action));
    const from = parseDate(filters.dateFrom);
    if (from) conds.push(gte(activityLogs.createdAt, from));
    const to = parseDate(filters.dateTo, true);
    if (to) conds.push(lte(activityLogs.createdAt, to));
    if (filters.search) {
      const like = `%${filters.search}%`;
      const search = or(
        ilike(activityLogs.actorEmail, like),
        ilike(activityLogs.path, like),
        ilike(activityLogs.resourceSummary, like),
      );
      if (search) conds.push(search);
    }
    const where = conds.length ? and(...conds) : undefined;

    const db = this.database.db;
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(activityLogs)
        .where(where)
        .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize),
      db.select({ total: count() }).from(activityLogs).where(where),
    ]);

    return {
      data: rows.map(toActivityLog),
      meta: { page: page.page, pageSize: page.pageSize, total: totals[0]?.total ?? 0 },
    };
  }
}

/** Lenient ISO parse; a date-only `dateTo` is pushed to end-of-day (WIB-agnostic: UTC). */
function parseDate(raw: string | undefined, endOfDay = false): Date | undefined {
  if (!raw) return undefined;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(isDateOnly && endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
