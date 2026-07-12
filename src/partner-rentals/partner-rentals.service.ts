import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, gte, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { rentals } from '../db/schema';
import { CreateRentalDto } from './dto/create-rental.dto';
import {
  currentPeriodWib,
  matchesSearch,
  monthBounds,
  nettByType,
  NettByTypeDto,
  PaymentStatus,
  presentRental,
  RentalItemDto,
  RentalSortField,
  RentalSummaryDto,
  SORT_FIELDS,
  SortOrder,
  sortRentalItems,
  summarizeRentals,
} from './rental-presenter';

export interface ListRentalsFilters {
  month?: number;
  year?: number;
  region?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}

export interface RentalMonitoringDto {
  summary: RentalSummaryDto;
  nettByType: NettByTypeDto[];
  regions: string[];
  items: RentalItemDto[];
}

/** Rental Monitoring CRUD + monthly recap, row-scoped to the session partnerId. */
@Injectable()
export class PartnerRentalsService {
  constructor(private readonly database: DatabaseService) {}

  async list(partnerId: number, filters: ListRentalsFilters): Promise<RentalMonitoringDto> {
    const period = this.resolvePeriod(filters);
    const { start, end } = monthBounds(period.year, period.month);

    // Month + partner scope MUST be SQL; a rental is in the month when its
    // inclusive [start_date, end_date] range overlaps it.
    const rows = await this.database.db
      .select()
      .from(rentals)
      .where(
        and(
          eq(rentals.partnerId, partnerId),
          lte(rentals.startDate, end),
          gte(rentals.endDate, start),
        ),
      );

    let items = rows.map((r) => presentRental(r, period));

    const region = filters.region?.trim();
    if (region) items = items.filter((i) => i.region === region);
    const search = filters.search?.trim();
    if (search) items = items.filter((i) => matchesSearch(i, search));

    items = sortRentalItems(
      items,
      this.resolveSortBy(filters.sortBy),
      this.resolveSortOrder(filters.sortOrder),
    );

    return {
      summary: summarizeRentals(items),
      nettByType: nettByType(items),
      regions: await this.regions(partnerId),
      items,
    };
  }

  async create(partnerId: number, dto: CreateRentalDto): Promise<RentalItemDto> {
    const values = this.toRowValues(dto);
    await this.assertNoOverlap(partnerId, values.plateNumberNorm, dto, values.plateNumber);

    const [row] = await this.database.db
      .insert(rentals)
      .values({ partnerId, ...values })
      .returning();
    return presentRental(row!);
  }

  async update(partnerId: number, id: number, dto: CreateRentalDto): Promise<RentalItemDto> {
    await this.requireOwned(partnerId, id);
    const values = this.toRowValues(dto);
    await this.assertNoOverlap(partnerId, values.plateNumberNorm, dto, values.plateNumber, id);

    const [row] = await this.database.db
      .update(rentals)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(rentals.id, id), eq(rentals.partnerId, partnerId)))
      .returning();
    return presentRental(row!);
  }

  async remove(partnerId: number, id: number): Promise<{ deleted: true }> {
    const [row] = await this.database.db
      .delete(rentals)
      .where(and(eq(rentals.id, id), eq(rentals.partnerId, partnerId)))
      .returning({ id: rentals.id });
    if (!row) throw new NotFoundException('Rental tidak ditemukan');
    return { deleted: true };
  }

  async updatePaymentStatus(
    partnerId: number,
    id: number,
    paymentStatus: PaymentStatus,
  ): Promise<RentalItemDto> {
    const [row] = await this.database.db
      .update(rentals)
      .set({ paymentStatus, updatedAt: new Date() })
      .where(and(eq(rentals.id, id), eq(rentals.partnerId, partnerId)))
      .returning();
    if (!row) throw new NotFoundException('Rental tidak ditemukan');
    return presentRental(row);
  }

  // ---- internals -------------------------------------------------------------

  /** Distinct non-empty regions across ALL the partner's rentals, sorted asc. */
  private async regions(partnerId: number): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ region: rentals.region })
      .from(rentals)
      .where(
        and(eq(rentals.partnerId, partnerId), isNotNull(rentals.region), ne(rentals.region, '')),
      )
      .orderBy(asc(rentals.region));
    return rows.map((r) => r.region!);
  }

  /** month/year defaults resolve to the current WIB period; validated 1..12 / 2020..2099. */
  resolvePeriod(filters: ListRentalsFilters): { month: number; year: number } {
    const now = currentPeriodWib();
    const month = filters.month ?? now.month;
    const year = filters.year ?? now.year;
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month must be an integer 1..12');
    }
    if (!Number.isInteger(year) || year < 2020 || year > 2099) {
      throw new BadRequestException('year must be an integer 2020..2099');
    }
    return { month, year };
  }

  private resolveSortBy(raw: string | undefined): RentalSortField {
    if (raw == null || raw === '') return 'date';
    if (!(SORT_FIELDS as readonly string[]).includes(raw)) {
      throw new BadRequestException(`sortBy must be one of: ${SORT_FIELDS.join(', ')}`);
    }
    return raw as RentalSortField;
  }

  private resolveSortOrder(raw: string | undefined): SortOrder {
    if (raw == null || raw === '') return 'asc';
    if (raw !== 'asc' && raw !== 'desc') {
      throw new BadRequestException('sortOrder must be asc or desc');
    }
    return raw;
  }

  /** DTO → column values shared by create/update (also validates the range). */
  private toRowValues(dto: CreateRentalDto) {
    const norm = normalizePlate(dto.plateNumber);
    if (!norm) throw new BadRequestException('Nomor plat tidak valid');
    const startDate = dto.startDate.slice(0, 10);
    const endDate = dto.endDate.slice(0, 10);
    if (endDate < startDate) {
      throw new BadRequestException('Tanggal selesai tidak boleh lebih kecil dari tanggal mulai.');
    }
    // Monthly price is stored as a per-day rate (legacy: month = 30 days).
    const pricePerDay = dto.priceUnit === 'bulan' ? Math.round(dto.price / 30) : dto.price;
    return {
      plateNumber: dto.plateNumber.trim(),
      plateNumberNorm: norm,
      vehicleType: dto.vehicleType?.trim() || null,
      region: dto.region?.trim() || null,
      startDate,
      endDate,
      pricePerDay,
      cogsPerDay: dto.cogsPerDay,
      cogsType: dto.cogsType?.trim() || null,
      additionalCost: dto.additionalCost ?? 0,
      additionalCostDescription: dto.additionalCostDescription?.trim() || null,
      deposit: dto.deposit ?? 0,
      rentalType: dto.rentalType ?? null,
      infoSource: dto.infoSource?.trim() || null,
      serviceArea: dto.serviceArea?.trim() || null,
      customerName: dto.customerName?.trim() || null,
      customerPhone: dto.customerPhone?.trim() || null,
      paymentStatus: dto.paymentStatus ?? 'Belum Dibayar',
    };
  }

  private async requireOwned(partnerId: number, id: number): Promise<void> {
    const [row] = await this.database.db
      .select({ id: rentals.id })
      .from(rentals)
      .where(and(eq(rentals.id, id), eq(rentals.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Rental tidak ditemukan');
  }

  /** Same plate must not have two rentals of this partner on overlapping dates. */
  private async assertNoOverlap(
    partnerId: number,
    plateNumberNorm: string,
    dto: { startDate: string; endDate: string },
    plateDisplay: string,
    excludeId?: number,
  ): Promise<void> {
    const [clash] = await this.database.db
      .select({ id: rentals.id })
      .from(rentals)
      .where(
        and(
          eq(rentals.partnerId, partnerId),
          eq(rentals.plateNumberNorm, plateNumberNorm),
          lte(rentals.startDate, dto.endDate.slice(0, 10)),
          gte(rentals.endDate, dto.startDate.slice(0, 10)),
          excludeId != null ? ne(rentals.id, excludeId) : sql`true`,
        ),
      )
      .limit(1);
    if (clash) {
      throw new ConflictException(
        `Plat ${plateDisplay} sudah memiliki rental pada rentang tanggal tersebut.`,
      );
    }
  }
}
