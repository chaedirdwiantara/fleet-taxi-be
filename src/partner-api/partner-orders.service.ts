import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { count, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from '../db/database.service';
import { orders } from '../db/schema';
import { PricelistService } from './pricelist.service';

export interface CreateOrderInput {
  pickupCode: string;
  destinationCode: string;
  carTypesId: number;
  pickupAt: string; // ISO 8601 or legacy "YYYY-MM-DD HH:mm:ss" (Asia/Jakarta)
  passengerDetails?: unknown;
}

/** All queries scoped by the API key's partnerId; cross-partner reads → 403. */
@Injectable()
export class PartnerOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly pricelistService: PricelistService,
  ) {}

  private parsePickupAt(raw: string): Date {
    // legacy format has no timezone — interpret as Asia/Jakarta (UTC+7)
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? raw.replace(' ', 'T') + '+07:00'
      : raw;
    const d = new Date(normalized);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('pickupAt must be ISO 8601 or "YYYY-MM-DD HH:mm:ss"');
    }
    return d;
  }

  async create(partnerId: number, input: CreateOrderInput) {
    const quote = this.pricelistService.quote(input.pickupCode, input.destinationCode);
    const pickupAt = this.parsePickupAt(input.pickupAt);

    const [row] = await this.database.db
      .insert(orders)
      .values({
        orderNumber: `FT-${Date.now().toString(36).toUpperCase()}-${nanoid(6)}`,
        partnerId,
        orderType: 'later', // legacy order_type
        tripStatus: 'submitted',
        pickupCode: quote.pickupCode,
        destinationCode: quote.destinationCode,
        carTypesId: input.carTypesId,
        pickupAt,
        basicPrice: quote.price,
        isSwapTrip: this.pricelistService.isSwapTrip(quote.destinationCode),
        passengerDetails: input.passengerDetails ?? null,
      })
      .returning();
    return row;
  }

  async list(partnerId: number, page: number, pageSize: number) {
    const { db } = this.database;
    const where = eq(orders.partnerId, partnerId);
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(orders)
        .where(where)
        .orderBy(desc(orders.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(orders).where(where),
    ]);
    return { data: rows, meta: { page, pageSize, total: Number(total?.n ?? 0) } };
  }

  async detail(partnerId: number, orderId: number) {
    const [row] = await this.database.db.select().from(orders).where(eq(orders.id, orderId));
    if (!row) throw new NotFoundException(`Order ${orderId} not found`);
    if (row.partnerId !== partnerId) throw new ForbiddenException('Cross-partner access denied');
    return row;
  }
}
