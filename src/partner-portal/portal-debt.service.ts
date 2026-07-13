import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { fleetTargets, grabTargets } from '../db/schema';
import {
  buildDebtFilters,
  buildDebtRows,
  filterDebtRows,
  paginateDebtRows,
  sortDebtRows,
  type DebtFiltersDto,
  type DebtQuery,
  type DebtRowDto,
  type GojekPlateStat,
  type GrabDriverStat,
} from './debt-presenter';
import { PortalPlatesService } from './portal-plates.service';

/**
 * Debt Summary for the partner portal. Reads the SAME import tables the
 * Gojek/Grab fleet-monitoring screens read (fleet_import_details,
 * grab_import_details + their target tables), so the numbers are always in
 * sync with fleet monitoring — there is no separate debt store. Every query
 * is scoped to the partner's registered plates resolved from the SESSION
 * partnerId; a partner with no plates sees an empty summary.
 */
@Injectable()
export class PortalDebtService {
  constructor(
    private readonly database: DatabaseService,
    private readonly plates: PortalPlatesService,
  ) {}

  async list(
    partnerId: number,
    query: DebtQuery,
    page: number,
    pageSize: number,
  ): Promise<{ data: DebtRowDto[]; meta: { page: number; pageSize: number; total: number } }> {
    const rows = await this.buildRows(partnerId);
    return paginateDebtRows(sortDebtRows(filterDebtRows(rows, query), query), page, pageSize);
  }

  async filters(partnerId: number): Promise<DebtFiltersDto> {
    return buildDebtFilters(await this.buildRows(partnerId));
  }

  /** Filtered + sorted, unpaginated — feeds the XLSX export. */
  async allForExport(partnerId: number, query: DebtQuery): Promise<DebtRowDto[]> {
    const rows = await this.buildRows(partnerId);
    return sortDebtRows(filterDebtRows(rows, query), query);
  }

  private async buildRows(partnerId: number): Promise<DebtRowDto[]> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    if (scopePlates.length === 0) return [];
    const [gojek, grab] = await Promise.all([
      this.gojekStats(scopePlates),
      this.grabStats(scopePlates),
    ]);
    return buildDebtRows(gojek, grab);
  }

  /**
   * All-time per-plate Gojek aggregates: setoran terbayar (deduction + manual
   * payment yang masuk setoran), deposit terbayar (manual payment "Tidak Masuk
   * Setoran"), distinct deduction days and the due average — the same buckets
   * gojek-grid.service.ts derives its `outstanding` from.
   */
  private async gojekStats(scopePlates: string[]): Promise<GojekPlateStat[]> {
    const { db } = this.database;
    const plateList = sql.join(
      scopePlates.map((p) => sql`${p}`),
      sql`, `,
    );

    const aggregates = await db.execute(sql`
      SELECT
        vehicle_plate_norm AS plate,
        SUM(CASE
            WHEN type ILIKE '%deduction%' THEN ABS(amount)
            WHEN type ILIKE '%manual payment%' AND COALESCE(is_manual_payment_setoran, 1) = 1 THEN ABS(amount)
            ELSE 0
        END)::bigint AS setoran_paid,
        SUM(CASE
            WHEN type ILIKE '%manual payment%' AND COALESCE(is_manual_payment_setoran, 1) = 0 THEN ABS(amount)
            ELSE 0
        END)::bigint AS deposit_paid,
        COUNT(DISTINCT CASE WHEN type ILIKE '%deduction%' THEN transaction_date END)::int AS active_days,
        SUM(CASE WHEN type ILIKE '%due%' THEN amount ELSE 0 END)::bigint AS total_due,
        COUNT(CASE WHEN type ILIKE '%due%' THEN 1 END)::int AS due_count,
        MAX(transaction_date)::text AS last_date
      FROM fleet_import_details
      WHERE (type ILIKE '%deduction%' OR type ILIKE '%due%' OR type ILIKE '%manual payment%')
        AND vehicle_plate_norm IN (${plateList})
      GROUP BY vehicle_plate_norm
    `);

    const drivers = await db.execute(sql`
      SELECT DISTINCT ON (vehicle_plate_norm)
        vehicle_plate_norm AS plate,
        driver_name
      FROM fleet_import_details
      WHERE vehicle_plate_norm IN (${plateList})
        AND COALESCE(driver_name, '') <> ''
      ORDER BY vehicle_plate_norm, transaction_date DESC, id DESC
    `);
    const driverByPlate = new Map<string, string>();
    for (const row of drivers as unknown as Array<Record<string, unknown>>) {
      driverByPlate.set(String(row.plate), String(row.driver_name));
    }

    const targets = await db.select().from(fleetTargets);

    return (aggregates as unknown as Array<Record<string, unknown>>).map((row) => {
      const plate = String(row.plate);
      // legacy target match: exact OR substring in either direction, first hit wins
      const target = targets.find((t) => {
        const tClean = t.vehiclePlateNorm || normalizePlate(t.vehiclePlate);
        return (
          tClean !== '' &&
          plate !== '' &&
          (tClean === plate || tClean.includes(plate) || plate.includes(tClean))
        );
      });
      return {
        plate,
        driverName: driverByPlate.get(plate) ?? '',
        setoranPaid: Number(row.setoran_paid),
        depositPaid: Number(row.deposit_paid),
        activeDays: Number(row.active_days),
        totalDue: Number(row.total_due),
        dueCount: Number(row.due_count),
        lastDate: String(row.last_date),
        fleetTarget: target?.fleetTarget ?? 0,
        serviceArea: target?.serviceArea ?? '',
        rentalPartner: target?.rentalPartner ?? '',
      };
    });
  }

  /** Latest Grab appearance per plate+driver — identity, phone and city only. */
  private async grabStats(scopePlates: string[]): Promise<GrabDriverStat[]> {
    const { db } = this.database;
    const plateList = sql.join(
      scopePlates.map((p) => sql`${p}`),
      sql`, `,
    );

    const rows = (await db.execute(sql`
      SELECT DISTINCT ON (plate_number_norm, UPPER(COALESCE(driver_name, '')))
        plate_number_norm AS plate,
        driver_name,
        driver_phone_number AS phone,
        city,
        date::text AS last_date
      FROM grab_import_details
      WHERE plate_number_norm IN (${plateList})
      ORDER BY plate_number_norm, UPPER(COALESCE(driver_name, '')), date DESC, id DESC
    `)) as unknown as Array<{
      plate: string;
      driver_name: string | null;
      phone: string | null;
      city: string | null;
      last_date: string;
    }>;

    const targets = await db.select().from(grabTargets);
    const partnerByPlate = new Map<string, string>();
    for (const t of targets) {
      const norm = normalizePlate(t.plateNumber);
      if (norm && t.rentalPartner) partnerByPlate.set(norm, t.rentalPartner);
    }

    return rows.map((row) => ({
      plate: row.plate,
      driverName: row.driver_name ?? '',
      phone: row.phone,
      city: row.city ?? '',
      lastDate: row.last_date,
      rentalPartner: partnerByPlate.get(row.plate) ?? '',
    }));
  }
}
