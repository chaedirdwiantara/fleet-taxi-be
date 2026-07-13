import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, SQL } from 'drizzle-orm';
import { Pagination } from '../common/util/pagination';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { drivers, partnerPlates } from '../db/schema';
import { DriverDocumentsService } from './driver-documents.service';
import {
  DriverDetail,
  DriverRegistrationDetail,
  DriverRegistrationSummary,
  DriverResignationDetail,
  DriverResignationSummary,
  DriverRow,
  DriverSummary,
  presentDriverDetail,
  presentDriverSummary,
  presentRegistrationDetail,
  presentRegistrationSummary,
  presentResignationDetail,
  presentResignationSummary,
} from './driver-presenter';
import { formatDriverCode } from './driver.constants';
import { CreateDriverRegistrationDto } from './dto/create-driver-registration.dto';
import { DriverDecisionDto, VerifyDriverRegistrationDto } from './dto/driver-decision.dto';
import { DriverDocCheckDto } from './dto/driver-doc-check.dto';
import { SetDriverDepositDto } from './dto/set-driver-deposit.dto';
import { UpdateDriverRegistrationDto } from './dto/update-driver-registration.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';

type Paginated<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };

async function countDrivers(db: DatabaseService['db'], where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(drivers)
    .where(where);
  return row?.total ?? 0;
}

/**
 * Driver lifecycle, row-scoped to the session partnerId (requirePartner):
 * registration (create → document checks → deposit → verify) → active roster
 * → resignation (deposit return). One drivers row travels through all three
 * stages; the three endpoint groups slice on registration_status/resigned_at.
 */
@Injectable()
export class PartnerDriversService {
  constructor(
    private readonly database: DatabaseService,
    private readonly documents: DriverDocumentsService,
  ) {}

  // ---- registrations (pending | rejected) --------------------------------

  async listRegistrations(
    partnerId: number,
    opts: Pagination & { q?: string },
  ): Promise<Paginated<DriverRegistrationSummary>> {
    const where = and(
      eq(drivers.partnerId, partnerId),
      inArray(drivers.registrationStatus, ['pending', 'rejected']),
      this.searchCondition(opts.q, [drivers.name, drivers.driverCode]),
    );
    const { rows, total } = await this.page(where, opts);
    return {
      data: rows.map(presentRegistrationSummary),
      meta: { page: opts.page, pageSize: opts.pageSize, total },
    };
  }

  async createRegistration(
    partnerId: number,
    dto: CreateDriverRegistrationDto,
  ): Promise<DriverRegistrationDetail> {
    const plate = await this.resolvePlate(partnerId, dto.plateNumber);
    const [row] = await this.database.db
      .insert(drivers)
      .values({
        partnerId,
        name: dto.name.trim(),
        email: dto.email?.trim() || null,
        phone: dto.phone?.trim() || null,
        address: dto.address?.trim() || null,
        ktpNo: dto.ktpNo?.trim() || null,
        simNo: dto.simNo?.trim() || null,
        simExpired: dto.simExpired ?? null,
        plateNumber: plate.plateNumber,
        plateNumberNorm: plate.plateNumberNorm,
        bankAccount: dto.bankAccount?.trim() || null,
      })
      .returning({ id: drivers.id });
    return this.registrationDetail(partnerId, row!.id);
  }

  async registrationDetail(partnerId: number, id: number): Promise<DriverRegistrationDetail> {
    const row = await this.ownedRegistration(partnerId, id);
    return presentRegistrationDetail(row, await this.documents.viewsForDriver(id));
  }

  async updateRegistration(
    partnerId: number,
    id: number,
    dto: UpdateDriverRegistrationDto,
  ): Promise<DriverRegistrationDetail> {
    await this.ownedRegistration(partnerId, id);
    await this.applyMasterData(partnerId, id, dto);
    return this.registrationDetail(partnerId, id);
  }

  /** Hard-deletes an unapproved registration (documents cascade + storage cleanup). */
  async removeRegistration(partnerId: number, id: number): Promise<{ deleted: true }> {
    const row = await this.ownedRegistration(partnerId, id);
    if (row.depositStatus === 'approved') {
      throw new ConflictException(
        'Deposit sudah disetujui — proses pengembalian deposit terlebih dahulu.',
      );
    }
    await this.documents.deleteStorageForDriver(id);
    await this.database.db
      .delete(drivers)
      .where(and(eq(drivers.id, id), eq(drivers.partnerId, partnerId)));
    return { deleted: true };
  }

  async docCheck(
    partnerId: number,
    id: number,
    dto: DriverDocCheckDto,
  ): Promise<DriverRegistrationDetail> {
    await this.ownedRegistration(partnerId, id);
    if (!(await this.documents.hasUploaded(id, dto.kind))) {
      throw new BadRequestException('Unggah dokumen terlebih dahulu');
    }
    const column = { ktp: 'ktpVerified', sim: 'simVerified', skck: 'skckVerified' }[dto.kind] as
      'ktpVerified' | 'simVerified' | 'skckVerified';
    await this.database.db
      .update(drivers)
      .set({ [column]: dto.verified, updatedAt: new Date() })
      .where(eq(drivers.id, id));
    return this.registrationDetail(partnerId, id);
  }

  /** Records the deposit amount and puts it in `waiting` for a decision. */
  async setDeposit(
    partnerId: number,
    id: number,
    dto: SetDriverDepositDto,
  ): Promise<DriverRegistrationDetail> {
    await this.ownedRegistration(partnerId, id);
    if (!(await this.documents.hasUploaded(id, 'deposit_proof'))) {
      throw new BadRequestException('Unggah bukti deposit terlebih dahulu');
    }
    await this.database.db
      .update(drivers)
      .set({
        depositAmount: dto.amount,
        depositStatus: 'waiting',
        depositNote: null,
        depositDecidedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id));
    return this.registrationDetail(partnerId, id);
  }

  async decideDeposit(
    partnerId: number,
    id: number,
    dto: DriverDecisionDto,
  ): Promise<DriverRegistrationDetail> {
    const row = await this.ownedRegistration(partnerId, id);
    if (row.depositStatus !== 'waiting') {
      throw new ConflictException('Deposit tidak sedang menunggu keputusan');
    }
    await this.database.db
      .update(drivers)
      .set({
        depositStatus: dto.action === 'approve' ? 'approved' : 'rejected',
        depositNote: dto.action === 'reject' ? dto.note?.trim() || null : null,
        depositDecidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id));
    return this.registrationDetail(partnerId, id);
  }

  /** Final registration decision; approval requires deposit + all doc checks. */
  async verifyRegistration(
    partnerId: number,
    id: number,
    dto: VerifyDriverRegistrationDto,
  ): Promise<DriverRegistrationDetail> {
    const row = await this.ownedRegistration(partnerId, id);
    if (dto.action === 'approve') {
      if (row.depositStatus !== 'approved') {
        throw new BadRequestException('Deposit belum disetujui');
      }
      if (!row.ktpVerified || !row.simVerified || !row.skckVerified) {
        throw new BadRequestException('Semua dokumen harus terverifikasi');
      }
      await this.database.db
        .update(drivers)
        .set({
          registrationStatus: 'approved',
          driverCode: formatDriverCode(id),
          rejectNote: null,
          updatedAt: new Date(),
        })
        .where(eq(drivers.id, id));
      // The row leaves the registration slice on approval — present directly.
      const approved = await this.ownedDriver(partnerId, id);
      return presentRegistrationDetail(approved, await this.documents.viewsForDriver(id));
    }
    await this.database.db
      .update(drivers)
      .set({
        registrationStatus: 'rejected',
        rejectNote: dto.rejectNote?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id));
    return this.registrationDetail(partnerId, id);
  }

  // ---- active drivers (approved, not resigned) ----------------------------

  async listDrivers(
    partnerId: number,
    opts: Pagination & { q?: string; plate?: string; active?: string },
  ): Promise<Paginated<DriverSummary>> {
    const conditions = [
      eq(drivers.partnerId, partnerId),
      eq(drivers.registrationStatus, 'approved'),
      isNull(drivers.resignedAt),
      this.searchCondition(opts.q, [drivers.name, drivers.driverCode, drivers.email]),
    ];
    if (opts.plate) {
      const norm = normalizePlate(opts.plate);
      if (norm) conditions.push(ilike(drivers.plateNumberNorm, `%${norm}%`));
    }
    if (opts.active === 'true' || opts.active === 'false') {
      conditions.push(eq(drivers.isActive, opts.active === 'true'));
    }
    const where = and(...conditions);
    const { rows, total } = await this.page(where, opts);
    return {
      data: rows.map(presentDriverSummary),
      meta: { page: opts.page, pageSize: opts.pageSize, total },
    };
  }

  async driverDetail(partnerId: number, id: number): Promise<DriverDetail> {
    const row = await this.ownedActiveDriver(partnerId, id);
    return presentDriverDetail(row, await this.documents.viewsForDriver(id));
  }

  async updateDriver(partnerId: number, id: number, dto: UpdateDriverDto): Promise<DriverDetail> {
    await this.ownedActiveDriver(partnerId, id);
    await this.applyMasterData(partnerId, id, dto, dto.isActive);
    return this.driverDetail(partnerId, id);
  }

  async resign(partnerId: number, id: number): Promise<DriverResignationDetail> {
    const row = await this.ownedDriver(partnerId, id);
    if (row.registrationStatus !== 'approved')
      throw new NotFoundException('Driver tidak ditemukan');
    if (row.resignedAt) throw new ConflictException('Driver sudah resign');
    await this.database.db
      .update(drivers)
      .set({
        resignedAt: new Date(),
        isActive: false,
        depositReturnStatus: 'none',
        depositReturnDecidedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id));
    return this.resignationDetail(partnerId, id);
  }

  // ---- resignations (resigned_at set) --------------------------------------

  async listResignations(
    partnerId: number,
    opts: Pagination & { q?: string },
  ): Promise<Paginated<DriverResignationSummary>> {
    const where = and(
      eq(drivers.partnerId, partnerId),
      isNotNull(drivers.resignedAt),
      this.searchCondition(opts.q, [drivers.name, drivers.driverCode]),
    );
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(drivers)
        .where(where)
        .orderBy(desc(drivers.resignedAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      countDrivers(this.database.db, where),
    ]);
    return {
      data: rows.map(presentResignationSummary),
      meta: { page: opts.page, pageSize: opts.pageSize, total },
    };
  }

  async resignationDetail(partnerId: number, id: number): Promise<DriverResignationDetail> {
    const row = await this.ownedResigned(partnerId, id);
    return presentResignationDetail(row, await this.documents.viewsForDriver(id));
  }

  /** Marks the deposit return as waiting for a decision (proof required). */
  async requestDepositReturn(partnerId: number, id: number): Promise<DriverResignationDetail> {
    await this.ownedResigned(partnerId, id);
    if (!(await this.documents.hasUploaded(id, 'deposit_return_proof'))) {
      throw new BadRequestException('Unggah bukti pengembalian terlebih dahulu');
    }
    await this.database.db
      .update(drivers)
      .set({ depositReturnStatus: 'waiting', depositReturnDecidedAt: null, updatedAt: new Date() })
      .where(eq(drivers.id, id));
    return this.resignationDetail(partnerId, id);
  }

  async decideDepositReturn(
    partnerId: number,
    id: number,
    dto: DriverDecisionDto,
  ): Promise<DriverResignationDetail> {
    const row = await this.ownedResigned(partnerId, id);
    if (row.depositReturnStatus !== 'waiting') {
      throw new ConflictException('Pengembalian deposit tidak sedang menunggu keputusan');
    }
    await this.database.db
      .update(drivers)
      .set({
        depositReturnStatus: dto.action === 'approve' ? 'approved' : 'rejected',
        depositReturnDecidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id));
    return this.resignationDetail(partnerId, id);
  }

  // ---- helpers --------------------------------------------------------------

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

  private async page(
    where: SQL | undefined,
    opts: Pagination,
  ): Promise<{ rows: DriverRow[]; total: number }> {
    const [rows, total] = await Promise.all([
      this.database.db
        .select()
        .from(drivers)
        .where(where)
        .orderBy(desc(drivers.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      countDrivers(this.database.db, where),
    ]);
    return { rows, total };
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

  /** Shared master-data PATCH for registrations and active drivers. */
  private async applyMasterData(
    partnerId: number,
    id: number,
    dto: UpdateDriverRegistrationDto,
    isActive?: boolean,
  ): Promise<void> {
    const plate =
      dto.plateNumber !== undefined
        ? await this.resolvePlate(partnerId, dto.plateNumber)
        : undefined;
    await this.database.db
      .update(drivers)
      .set({
        ...(dto.name !== undefined && { name: dto.name.trim() }),
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
        ...(isActive !== undefined && { isActive }),
        updatedAt: new Date(),
      })
      .where(eq(drivers.id, id));
  }

  private async ownedDriver(partnerId: number, id: number): Promise<DriverRow> {
    const [row] = await this.database.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.id, id), eq(drivers.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Driver tidak ditemukan');
    return row;
  }

  /** A driver still in the registration slice (pending | rejected). */
  private async ownedRegistration(partnerId: number, id: number): Promise<DriverRow> {
    const row = await this.ownedDriver(partnerId, id);
    if (row.registrationStatus === 'approved') {
      throw new NotFoundException('Registrasi driver tidak ditemukan');
    }
    return row;
  }

  /** An approved, not-yet-resigned driver (the active roster slice). */
  private async ownedActiveDriver(partnerId: number, id: number): Promise<DriverRow> {
    const row = await this.ownedDriver(partnerId, id);
    if (row.registrationStatus !== 'approved' || row.resignedAt) {
      throw new NotFoundException('Driver tidak ditemukan');
    }
    return row;
  }

  private async ownedResigned(partnerId: number, id: number): Promise<DriverRow> {
    const row = await this.ownedDriver(partnerId, id);
    if (!row.resignedAt) throw new NotFoundException('Driver tidak ditemukan');
    return row;
  }
}
