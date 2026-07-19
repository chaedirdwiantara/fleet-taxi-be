import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { depositInstallments } from '../db/schema';
import { normalizeDriverName } from '../partner-drivers/driver.constants';
import { PortalPlatesService } from '../partner-portal/portal-plates.service';
import { CreateDepositInstallmentDto } from './dto/create-deposit-installment.dto';
import {
  computeInstallments,
  filterRules,
  paginateRules,
  presentRule,
  sortRules,
  type DriverActiveDay,
  type InstallmentEntryDto,
  type InstallmentQuery,
  type InstallmentRule,
  type InstallmentRuleDto,
} from './installment-presenter';

interface DriverImportContext {
  days: DriverActiveDay[];
  lastPlateByDriver: Map<string, string>;
}

/**
 * Cicilan Deposit CRUD + derived installment history, row-scoped to the
 * session partnerId. Reads the SAME import table fleet monitoring reads
 * (fleet_import_details) — there is no installment log store; see
 * installment-presenter.ts for the derivation rules.
 */
@Injectable()
export class DepositInstallmentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly plates: PortalPlatesService,
  ) {}

  async list(
    partnerId: number,
    query: InstallmentQuery,
    page: number,
    pageSize: number,
  ): Promise<{
    data: InstallmentRuleDto[];
    meta: { page: number; pageSize: number; total: number };
  }> {
    const rows = await this.buildRows(partnerId);
    return paginateRules(sortRules(filterRules(rows, query), query), page, pageSize);
  }

  async create(partnerId: number, dto: CreateDepositInstallmentDto): Promise<InstallmentRuleDto> {
    const [row] = await this.database.db
      .insert(depositInstallments)
      .values({ partnerId, ...this.toRowValues(dto) })
      .returning();
    return this.presentOne(partnerId, this.toRule(row!));
  }

  async update(
    partnerId: number,
    id: number,
    dto: CreateDepositInstallmentDto,
  ): Promise<InstallmentRuleDto> {
    const [row] = await this.database.db
      .update(depositInstallments)
      .set({ ...this.toRowValues(dto), updatedAt: new Date() })
      .where(and(eq(depositInstallments.id, id), eq(depositInstallments.partnerId, partnerId)))
      .returning();
    if (!row) throw new NotFoundException('Cicilan deposit tidak ditemukan');
    return this.presentOne(partnerId, this.toRule(row));
  }

  async remove(partnerId: number, id: number): Promise<{ deleted: true }> {
    const [row] = await this.database.db
      .delete(depositInstallments)
      .where(and(eq(depositInstallments.id, id), eq(depositInstallments.partnerId, partnerId)))
      .returning({ id: depositInstallments.id });
    if (!row) throw new NotFoundException('Cicilan deposit tidak ditemukan');
    return { deleted: true };
  }

  /** Rule summary + the full derived installment history (the "Rekap" view). */
  async recap(
    partnerId: number,
    id: number,
  ): Promise<{ rule: InstallmentRuleDto; installments: InstallmentEntryDto[] }> {
    const [row] = await this.database.db
      .select()
      .from(depositInstallments)
      .where(and(eq(depositInstallments.id, id), eq(depositInstallments.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Cicilan deposit tidak ditemukan');

    const rule = this.toRule(row);
    const ctx = await this.importContext(partnerId, [rule.driverNameNorm]);
    const installments = computeInstallments(rule, ctx.days);
    return {
      rule: presentRule(rule, installments, ctx.lastPlateByDriver.get(rule.driverNameNorm) ?? null),
      installments,
    };
  }

  /**
   * Distinct driver names seen on the partner's plates (Gojek + Grab imports)
   * — feeds the driver picker so a rule always references a name the
   * derivation can actually match.
   */
  async driverOptions(
    partnerId: number,
  ): Promise<Array<{ driverName: string; lastPlate: string }>> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    if (scopePlates.length === 0) return [];
    const plateList = sql.join(
      scopePlates.map((p) => sql`${p}`),
      sql`, `,
    );

    const rows = (await this.database.db.execute(sql`
      SELECT driver_name, plate, last_date FROM (
        SELECT DISTINCT ON (UPPER(driver_name))
          driver_name, vehicle_plate_norm AS plate, transaction_date::text AS last_date
        FROM fleet_import_details
        WHERE vehicle_plate_norm IN (${plateList}) AND COALESCE(driver_name, '') <> ''
        ORDER BY UPPER(driver_name), transaction_date DESC, id DESC
      ) gojek
      UNION ALL
      SELECT driver_name, plate, last_date FROM (
        SELECT DISTINCT ON (UPPER(driver_name))
          driver_name, plate_number_norm AS plate, date::text AS last_date
        FROM grab_import_details
        WHERE plate_number_norm IN (${plateList}) AND COALESCE(driver_name, '') <> ''
        ORDER BY UPPER(driver_name), date DESC, id DESC
      ) grab
    `)) as unknown as Array<{ driver_name: string; plate: string; last_date: string }>;

    // Merge Gojek + Grab on the normalized name; keep the freshest plate.
    const byNorm = new Map<string, { driverName: string; lastPlate: string; lastDate: string }>();
    for (const row of rows) {
      const norm = normalizeDriverName(row.driver_name);
      const existing = byNorm.get(norm);
      if (!existing || row.last_date > existing.lastDate) {
        byNorm.set(norm, { driverName: norm, lastPlate: row.plate, lastDate: row.last_date });
      }
    }
    return [...byNorm.values()]
      .sort((a, b) => a.driverName.localeCompare(b.driverName, 'id'))
      .map(({ driverName, lastPlate }) => ({ driverName, lastPlate }));
  }

  // ---- internals -------------------------------------------------------------

  private async buildRows(partnerId: number): Promise<InstallmentRuleDto[]> {
    const rows = await this.database.db
      .select()
      .from(depositInstallments)
      .where(eq(depositInstallments.partnerId, partnerId));
    if (rows.length === 0) return [];

    const rules = rows.map((r) => this.toRule(r));
    const ctx = await this.importContext(partnerId, [
      ...new Set(rules.map((r) => r.driverNameNorm)),
    ]);
    return rules.map((rule) =>
      presentRule(
        rule,
        computeInstallments(rule, ctx.days),
        ctx.lastPlateByDriver.get(rule.driverNameNorm) ?? null,
      ),
    );
  }

  private async presentOne(partnerId: number, rule: InstallmentRule): Promise<InstallmentRuleDto> {
    const ctx = await this.importContext(partnerId, [rule.driverNameNorm]);
    return presentRule(
      rule,
      computeInstallments(rule, ctx.days),
      ctx.lastPlateByDriver.get(rule.driverNameNorm) ?? null,
    );
  }

  /**
   * Per-driver daily aggregates over the partner's plates: a row per (driver,
   * date) that has >= 1 deduction transaction, with that day's setoran paid
   * (same CASE buckets the debt summary / fleet grid used). A partner with no
   * registered plates yields no days — every rule shows paidCount 0.
   */
  private async importContext(
    partnerId: number,
    driverNorms: string[],
  ): Promise<DriverImportContext> {
    if (driverNorms.length === 0) return { days: [], lastPlateByDriver: new Map() };
    const scopePlates = await this.plates.registeredNorms(partnerId);
    if (scopePlates.length === 0) return { days: [], lastPlateByDriver: new Map() };

    const plateList = sql.join(
      scopePlates.map((p) => sql`${p}`),
      sql`, `,
    );

    const dayRows = (await this.database.db.execute(sql`
      SELECT
        UPPER(driver_name) AS driver_name_upper,
        transaction_date::text AS date,
        SUM(CASE
            WHEN type ILIKE '%deduction%' THEN ABS(amount)
            WHEN type ILIKE '%manual payment%' AND COALESCE(is_manual_payment_setoran, 1) = 1 THEN ABS(amount)
            ELSE 0
        END)::bigint AS setoran_paid,
        COUNT(CASE WHEN type ILIKE '%deduction%' THEN 1 END)::int AS deduction_count
      FROM fleet_import_details
      WHERE (type ILIKE '%deduction%' OR type ILIKE '%manual payment%')
        AND vehicle_plate_norm IN (${plateList})
        AND COALESCE(driver_name, '') <> ''
      GROUP BY UPPER(driver_name), transaction_date
    `)) as unknown as Array<{
      driver_name_upper: string;
      date: string;
      setoran_paid: string | number;
      deduction_count: number;
    }>;

    const wanted = new Set(driverNorms);
    const days: DriverActiveDay[] = [];
    for (const row of dayRows) {
      // SQL UPPER() does not collapse whitespace — finish normalizing in JS so
      // both sides use the exact normalizeDriverName() identity.
      const norm = normalizeDriverName(row.driver_name_upper);
      // active day = at least one deduction row that date
      if (!wanted.has(norm) || Number(row.deduction_count) === 0) continue;
      days.push({ driverNameNorm: norm, date: row.date, setoranPaid: Number(row.setoran_paid) });
    }

    const plateRows = (await this.database.db.execute(sql`
      SELECT DISTINCT ON (UPPER(driver_name))
        driver_name, vehicle_plate_norm AS plate
      FROM fleet_import_details
      WHERE vehicle_plate_norm IN (${plateList}) AND COALESCE(driver_name, '') <> ''
      ORDER BY UPPER(driver_name), transaction_date DESC, id DESC
    `)) as unknown as Array<{ driver_name: string; plate: string }>;

    const lastPlateByDriver = new Map<string, string>();
    for (const row of plateRows) {
      const norm = normalizeDriverName(row.driver_name);
      if (!lastPlateByDriver.has(norm)) lastPlateByDriver.set(norm, row.plate);
    }

    return { days, lastPlateByDriver };
  }

  private toRowValues(dto: CreateDepositInstallmentDto) {
    const driverName = normalizeDriverName(dto.driverName);
    return {
      title: dto.title.trim(),
      driverName,
      driverNameNorm: driverName,
      installmentAmount: dto.installmentAmount,
      installmentCount: dto.installmentCount,
      minDailySetoran: dto.minDailySetoran ?? null,
      effectiveDate: dto.effectiveDate.slice(0, 10),
      note: dto.note?.trim() || null,
    };
  }

  private toRule(row: typeof depositInstallments.$inferSelect): InstallmentRule {
    return {
      id: row.id,
      partnerId: row.partnerId,
      title: row.title,
      driverName: row.driverName,
      driverNameNorm: row.driverNameNorm,
      installmentAmount: row.installmentAmount,
      installmentCount: row.installmentCount,
      minDailySetoran: row.minDailySetoran,
      effectiveDate: row.effectiveDate,
      note: row.note,
      createdAt: row.createdAt,
    };
  }
}
