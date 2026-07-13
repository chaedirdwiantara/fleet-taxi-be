import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, isNotNull, isNull, or, sql, SQL } from 'drizzle-orm';
import { Pagination } from '../common/util/pagination';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { drivers, partnerPlates } from '../db/schema';
import { DriverDocumentsService } from './driver-documents.service';
import {
  DriverDetail,
  DriverRow,
  DriverSummary,
  presentDriverDetail,
  presentDriverSummary,
} from './driver-presenter';
import { normalizeDriverName } from './driver.constants';
import { UpdateDriverDto } from './dto/update-driver.dto';

type Paginated<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };

/**
 * Postgres unique_violation on the (partner_id, name_norm) sync key. Drizzle
 * wraps driver errors (DrizzleQueryError.cause), so walk the cause chain.
 */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const pg = e as { code?: string; constraint_name?: string };
    if (pg.code === '23505' && String(pg.constraint_name ?? '').includes('name_norm')) return true;
  }
  return false;
}

/**
 * Partner driver roster, row-scoped to the session partnerId (requirePartner).
 * Rows are created by DriverSyncService from the fleet import data; this
 * service covers listing (all lifecycle stages), detail, and the edit page:
 * master-data completeness plus the resign / deposit-return lifecycle.
 * There is deliberately no create or delete endpoint.
 */
@Injectable()
export class PartnerDriversService {
  constructor(
    private readonly database: DatabaseService,
    private readonly documents: DriverDocumentsService,
  ) {}

  async listDrivers(
    partnerId: number,
    opts: Pagination & { q?: string; plate?: string; active?: string; resigned?: string },
  ): Promise<Paginated<DriverSummary>> {
    const conditions = [
      eq(drivers.partnerId, partnerId),
      this.searchCondition(opts.q, [drivers.name, drivers.driverCode, drivers.email]),
    ];
    if (opts.plate) {
      const norm = normalizePlate(opts.plate);
      if (norm) conditions.push(ilike(drivers.plateNumberNorm, `%${norm}%`));
    }
    if (opts.active === 'true' || opts.active === 'false') {
      conditions.push(eq(drivers.isActive, opts.active === 'true'));
    }
    if (opts.resigned === 'true') conditions.push(isNotNull(drivers.resignedAt));
    else if (opts.resigned === 'false') conditions.push(isNull(drivers.resignedAt));

    const where = and(...conditions);
    const [rows, [count]] = await Promise.all([
      this.database.db
        .select()
        .from(drivers)
        .where(where)
        .orderBy(desc(drivers.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      this.database.db
        .select({ total: sql<number>`count(*)::int` })
        .from(drivers)
        .where(where),
    ]);
    return {
      data: rows.map(presentDriverSummary),
      meta: { page: opts.page, pageSize: opts.pageSize, total: count?.total ?? 0 },
    };
  }

  async driverDetail(partnerId: number, id: number): Promise<DriverDetail> {
    const row = await this.ownedDriver(partnerId, id);
    return presentDriverDetail(row, await this.documents.viewsForDriver(id));
  }

  async updateDriver(partnerId: number, id: number, dto: UpdateDriverDto): Promise<DriverDetail> {
    const row = await this.ownedDriver(partnerId, id);

    const plate =
      dto.plateNumber !== undefined
        ? await this.resolvePlate(partnerId, dto.plateNumber)
        : undefined;

    // Lifecycle: resign / un-resign, and the deposit-return decision.
    const lifecycle = this.lifecyclePatch(row, dto);
    if (
      dto.depositReturned === true &&
      !(await this.documents.hasUploaded(id, 'deposit_return_proof'))
    ) {
      throw new BadRequestException('Unggah bukti pengembalian deposit terlebih dahulu');
    }

    try {
      await this.database.db
        .update(drivers)
        .set({
          ...(dto.name !== undefined && {
            name: dto.name.trim(),
            nameNorm: normalizeDriverName(dto.name),
          }),
          ...(dto.email !== undefined && { email: dto.email.trim() || null }),
          ...(dto.phone !== undefined && { phone: dto.phone.trim() || null }),
          ...(dto.address !== undefined && { address: dto.address.trim() || null }),
          ...(dto.ktpNo !== undefined && { ktpNo: dto.ktpNo.trim() || null }),
          ...(dto.simNo !== undefined && { simNo: dto.simNo.trim() || null }),
          ...(dto.simExpired !== undefined && { simExpired: dto.simExpired || null }),
          ...(plate !== undefined && {
            plateNumber: plate.plateNumber,
            plateNumberNorm: plate.plateNumberNorm,
          }),
          ...(dto.bankAccount !== undefined && { bankAccount: dto.bankAccount.trim() || null }),
          ...(dto.depositAmount !== undefined && { depositAmount: dto.depositAmount }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...lifecycle,
          updatedAt: new Date(),
        })
        .where(eq(drivers.id, id));
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('Nama driver sudah ada');
      throw err;
    }
    return this.driverDetail(partnerId, id);
  }

  // ---- helpers --------------------------------------------------------------

  /**
   * `resigned` / `depositReturned` toggles → column patch.
   * - resign: stamps resignedAt (once) and deactivates the driver;
   * - un-resign: clears resignedAt AND resets the deposit-return decision;
   * - depositReturned only means something for a resigned driver (the proof
   *   gate is enforced by the caller before writing).
   */
  private lifecyclePatch(
    row: DriverRow,
    dto: UpdateDriverDto,
  ): Partial<typeof drivers.$inferInsert> {
    const patch: Partial<typeof drivers.$inferInsert> = {};
    if (dto.resigned === true) {
      patch.resignedAt = row.resignedAt ?? new Date();
      patch.isActive = false;
    } else if (dto.resigned === false) {
      patch.resignedAt = null;
      patch.depositReturnStatus = 'none';
      patch.depositReturnDecidedAt = null;
    }

    if (dto.depositReturned !== undefined) {
      const resigned = dto.resigned ?? !!row.resignedAt;
      if (dto.depositReturned && !resigned) {
        throw new BadRequestException('Driver belum resign');
      }
      if (dto.resigned !== false) {
        patch.depositReturnStatus = dto.depositReturned ? 'approved' : 'none';
        patch.depositReturnDecidedAt = dto.depositReturned ? new Date() : null;
      }
    }
    return patch;
  }

  private searchCondition(
    q: string | undefined,
    columns: (typeof drivers.name | typeof drivers.driverCode | typeof drivers.email)[],
  ): SQL | undefined {
    const term = q?.trim();
    if (!term) return undefined;
    // ilike pattern-escape so a literal "%" in the search stays literal
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    return or(...columns.map((c) => ilike(c, pattern)));
  }

  /**
   * Resolves an (optional) operated plate against the partner's allowlist.
   * Stored as text like checkpoints/rentals — validated at write time only.
   */
  private async resolvePlate(
    partnerId: number,
    plateNumber: string | undefined,
  ): Promise<{ plateNumber: string | null; plateNumberNorm: string | null }> {
    const trimmed = plateNumber?.trim();
    if (!trimmed) return { plateNumber: null, plateNumberNorm: null };
    const norm = normalizePlate(trimmed);
    if (!norm) throw new BadRequestException('Nomor plat tidak valid');
    const [registered] = await this.database.db
      .select({ id: partnerPlates.id })
      .from(partnerPlates)
      .where(and(eq(partnerPlates.partnerId, partnerId), eq(partnerPlates.plateNumberNorm, norm)));
    if (!registered) throw new BadRequestException('Plat tidak terdaftar untuk partner Anda');
    return { plateNumber: trimmed, plateNumberNorm: norm };
  }

  private async ownedDriver(partnerId: number, id: number): Promise<DriverRow> {
    const [row] = await this.database.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.id, id), eq(drivers.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Driver tidak ditemukan');
    return row;
  }
}
