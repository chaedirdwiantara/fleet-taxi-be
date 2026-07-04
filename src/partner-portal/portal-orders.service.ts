import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { orders, partners } from '../db/schema';

export interface OrderListQuery {
  page: number;
  pageSize: number;
  tripStatus?: string;
}

/**
 * Every query here is row-scoped to the caller's partnerId — a partner can
 * never read another partner's orders (PROJECT-BRIEF.md §4 RBAC).
 */
@Injectable()
export class PortalOrdersService {
  constructor(private readonly database: DatabaseService) {}

  async partnerProfile(partnerId: number) {
    const [row] = await this.database.db.select().from(partners).where(eq(partners.id, partnerId));
    if (!row) throw new NotFoundException('Partner not found');
    return row;
  }

  async list(partnerId: number, query: OrderListQuery) {
    const { db } = this.database;
    const where = query.tripStatus
      ? and(eq(orders.partnerId, partnerId), eq(orders.tripStatus, query.tripStatus))
      : eq(orders.partnerId, partnerId);

    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ n: count() }).from(orders).where(where),
    ]);

    return {
      data: rows,
      meta: { page: query.page, pageSize: query.pageSize, total: Number(total?.n ?? 0) },
    };
  }

  async detail(partnerId: number, orderId: number) {
    const [row] = await this.database.db.select().from(orders).where(eq(orders.id, orderId));
    if (!row) throw new NotFoundException(`Order ${orderId} not found`);
    if (row.partnerId !== partnerId) {
      throw new ForbiddenException('Order belongs to another partner');
    }
    return row;
  }

  /** All rows for export — still scoped; volume per partner is modest in R1. */
  async allForExport(partnerId: number) {
    return this.database.db
      .select()
      .from(orders)
      .where(eq(orders.partnerId, partnerId))
      .orderBy(desc(orders.createdAt))
      .limit(10_000);
  }

  async dashboard(partnerId: number) {
    const { db } = this.database;
    // month bucket in the business timezone (Asia/Jakarta)
    const monthStart = sql`date_trunc('month', (now() AT TIME ZONE 'Asia/Jakarta'))`;

    const [totals] = await db
      .select({
        totalOrders: count(),
        monthOrders: count(
          sql`CASE WHEN (${orders.createdAt} AT TIME ZONE 'Asia/Jakarta') >= ${monthStart} THEN 1 END`,
        ),
        monthRevenue: sql<string>`COALESCE(SUM(CASE
          WHEN (${orders.createdAt} AT TIME ZONE 'Asia/Jakarta') >= ${monthStart}
           AND ${orders.tripStatus} <> 'draft'
          THEN ${orders.basicPrice} ELSE 0 END), 0)`,
      })
      .from(orders)
      .where(eq(orders.partnerId, partnerId));

    const recentOrders = await db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.partnerId, partnerId),
          gte(orders.createdAt, sql`now() - interval '90 days'`),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(10);

    return {
      totalOrders: Number(totals?.totalOrders ?? 0),
      ordersThisMonth: Number(totals?.monthOrders ?? 0),
      revenueThisMonth: Number(totals?.monthRevenue ?? 0),
      recentOrders,
    };
  }
}
