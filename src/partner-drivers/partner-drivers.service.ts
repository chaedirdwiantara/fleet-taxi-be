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
import { CreateDriverDto } from './dto/create-driver.dto';
import { DriverMasterDataDto } from './dto/driver-master-data.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';

type Paginated<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };

/** How a driver left the fleet — narrows the `resigned=true` list. */
export type ResignedType = 'manual' | 'auto';

export interface ListDriversOptions extends Pagination {
  q?: string;
  plate?: string;
  active?: string;
  /** 'true' = out of the fleet (manual resign OR auto-detected exit). */
  resigned?: string;
  resignedType?: string;
}

/** Resolved plate pair, or `undefined` when the caller left the plate alone. */
type PlatePatch = { plateNumber: string | null; plateNumberNorm: string | null };

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
 * Rows come from DriverSyncService (fleet import data) or from manual
 * registration (`source: 'manual'`); this service covers listing (all lifecycle
 * stages), detail, creation, and the edit page: master-data completeness plus
 * the resign / deposit-return lifecycle. There is deliberately no delete
 * endpoint — a driver who leaves is resigned, never erased.
 */
@Injectable()
export class PartnerDriversService {
  constructor(
    private readonly database: DatabaseService,
    private readonly documents: DriverDocumentsService,
  ) {}

  async listDrivers(
    partnerId: number,
    opts: ListDriversOptions,
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
    const outOfFleet = opts.resigned === 'true';
    if (outOfFleet) conditions.push(this.resignedCondition(opts.resignedType));
    else if (opts.resigned === 'false') {
      conditions.push(isNull(drivers.resignedAt), isNull(drivers.exitedAt));
    }

    const where = and(...conditions);
    const [rows, [count]] = await Promise.all([
      this.database.db
        .select()
        .from(drivers)
        .where(where)
        // The resign list is read newest-departure first; the roster keeps its
        // join order. GREATEST ignores NULLs in Postgres, so it yields whichever
        // of the two dates a row actually has (ordering only — no TZ math).
        .orderBy(
          outOfFleet
            ? sql`greatest(${drivers.resignedAt}::date, ${drivers.exitedAt}) desc nulls last`
            : desc(drivers.createdAt),
        )
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

  /**
   * Manual registration. Shares the (partner_id, name_norm) identity with the
   * fleet sync on purpose: registering a driver the import already knows is a
   * 409 rather than a duplicate, and a driver registered by hand before the
   * first import simply absorbs the later sync instead of doubling up.
   */
  async createDriver(partnerId: number, dto: CreateDriverDto): Promise<DriverDetail> {
    const plate = await this.resolvePlate(partnerId, dto.plateNumber);
    const name = dto.name.trim();
    if (name === '') throw new BadRequestException('Nama driver wajib diisi');
    this.assertHomePinComplete(dto, { homeLat: null, homeLng: null });

    let id: number;
    try {
      const [row] = await this.database.db
        .insert(drivers)
        .values({
          partnerId,
          name,
          nameNorm: normalizeDriverName(name),
          source: 'manual',
          registrationStatus: 'approved', // legacy column; roster rows are live
          ...this.masterDataPatch(dto, plate),
          isActive: dto.isActive ?? true,
        })
        .returning({ id: drivers.id });
      id = row!.id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictException('Nama driver sudah ada');
      throw err;
    }

    // Same rule as the sync (formatDriverCode): DRV- + zero-padded row id.
    await this.database.db
      .update(drivers)
      .set({ driverCode: sql`'DRV-' || lpad(${drivers.id}::text, 6, '0')` })
      .where(eq(drivers.id, id));
    return this.driverDetail(partnerId, id);
  }

  async updateDriver(partnerId: number, id: number, dto: UpdateDriverDto): Promise<DriverDetail> {
    const row = await this.ownedDriver(partnerId, id);

    const plate =
      dto.plateNumber !== undefined
        ? await this.resolvePlate(partnerId, dto.plateNumber)
        : undefined;
    this.assertHomePinComplete(dto, row);

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
          ...this.masterDataPatch(dto, plate),
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
   * Master-data half of a create/update body → column patch. Only keys present
   * on the DTO are emitted, so a PATCH never clobbers untouched columns; an
   * empty string clears a text column and `null` clears a coordinate.
   * `plate` is pre-resolved by the caller (it needs the allowlist lookup).
   */
  private masterDataPatch(
    dto: DriverMasterDataDto,
    plate: PlatePatch | undefined,
  ): Partial<typeof drivers.$inferInsert> {
    return {
      ...(dto.email !== undefined && { email: dto.email.trim() || null }),
      ...(dto.phone !== undefined && { phone: dto.phone.trim() || null }),
      ...(dto.address !== undefined && { address: dto.address.trim() || null }),
      ...(dto.homeLat !== undefined && { homeLat: dto.homeLat }),
      ...(dto.homeLng !== undefined && { homeLng: dto.homeLng }),
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
    };
  }

  /**
   * The home pin is one value in two columns: the FE only ever writes both or
   * clears both, so half a coordinate is a bug, not a partial save. Checked
   * against the resulting row so a PATCH that touches only one column still has
   * to end up consistent.
   */
  private assertHomePinComplete(
    dto: DriverMasterDataDto,
    current: { homeLat: number | null; homeLng: number | null },
  ): void {
    const lat = dto.homeLat !== undefined ? dto.homeLat : current.homeLat;
    const lng = dto.homeLng !== undefined ? dto.homeLng : current.homeLng;
    if ((lat === null) !== (lng === null)) {
      throw new BadRequestException('Titik lokasi rumah harus berisi lintang dan bujur sekaligus');
    }
  }

  /**
   * "Out of the fleet" = manually resigned OR auto-detected as exited from the
   * import data — the two halves of the Driver Resign list. `resignedType`
   * narrows to one of them; `auto` deliberately excludes rows that were also
   * resigned by hand, so the two filters partition the list.
   */
  private resignedCondition(resignedType: string | undefined): SQL {
    if (resignedType === 'manual') return isNotNull(drivers.resignedAt);
    if (resignedType === 'auto') {
      return and(isNotNull(drivers.exitedAt), isNull(drivers.resignedAt))!;
    }
    return or(isNotNull(drivers.resignedAt), isNotNull(drivers.exitedAt))!;
  }

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
