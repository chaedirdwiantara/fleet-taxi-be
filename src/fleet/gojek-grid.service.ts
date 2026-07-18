import { Injectable } from '@nestjs/common';
import { and, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { byteCompare } from '../common/util/sort';
import { DatabaseService } from '../db/database.service';
import { fleetExceptions, fleetImportDetails, fleetTargets, rentals } from '../db/schema';
import { encodeDueSegments } from './due-segments';
import {
  DEFAULT_DAILY_TARGET,
  DailyDetailBucket,
  ExitedDriver,
  GojekGridResult,
  GojekPerformer,
  GojekVehicleRow,
  NO_RENTAL_PARTNER,
  RawManualRow,
} from './gojek-grid.types';

/**
 * Faithful port of legacy AdminFleetMonitoringController::buildMonitoringData.
 * The monthly pivot runs in TypeScript exactly like the legacy PHP loop
 * (≤ ~500 vehicles × 31 days per month — small); the cumulative outstanding
 * window (fetchCumulativeStats) is one SQL aggregate keyed on vehicle_plate_norm.
 */
@Injectable()
export class GojekGridService {
  constructor(private readonly database: DatabaseService) {}

  // ── legacy type helpers ───────────────────────────────────────────────
  private isManualPaymentType(type: string | null): boolean {
    return (type ?? '').toLowerCase().includes('manual payment');
  }
  private isDueType(type: string | null): boolean {
    return (type ?? '').toLowerCase().includes('due');
  }
  private isDeductionType(type: string | null): boolean {
    return (type ?? '').toLowerCase().includes('deduction');
  }
  private isManualPaymentCounted(type: string | null, flag: number | null): boolean {
    if (!this.isManualPaymentType(type)) return false;
    if (flag === null || flag === undefined) return true;
    return flag === 1;
  }
  private buildBreakdownLabel(type: string | null, isManual: boolean, counted: boolean): string {
    if (isManual) return counted ? 'Manual Payment' : 'Manual Payment (Tidak Masuk Setoran)';
    if ((type ?? '').toLowerCase().includes('rental fee deduction')) return 'Rental fee deduction';
    return (type ?? '').trim() || 'Other';
  }

  async buildGrid(
    month: number,
    year: number,
    filters: {
      rentalPartners?: string[];
      plates?: string[];
      plate?: string;
      // Server-derived plate allowlist (partner scoping). `undefined` = no scope
      // (admin); an EMPTY array = a partner with no registered plates → empty grid.
      // Never populate this from client input.
      scopePlates?: string[];
      // Server-derived norm → registering-partner-name map (Daftarkan Plat).
      // When present it is the authoritative Rental Partner label — the legacy
      // fleet_targets.rental_partner string only fills unregistered plates.
      partnerNameByNorm?: Map<string, string>;
      // Admin surface only: let unplated Manual Payment rows through the plate
      // scope so they land in the rawRows queue ("Data Mentah Tanpa Plat").
      // NEVER set for partner scoping — a partner must not see unplated data.
      includeRawManual?: boolean;
    } = {},
  ): Promise<GojekGridResult> {
    const { db } = this.database;

    if (filters.scopePlates !== undefined && filters.scopePlates.length === 0) {
      return this.emptyGrid(month, year);
    }

    const rawRows = await db
      .select()
      .from(fleetImportDetails)
      .where(
        and(
          eq(fleetImportDetails.periodYear, year),
          eq(fleetImportDetails.periodMonth, month),
          or(
            ilike(fleetImportDetails.type, '%deduction%'),
            ilike(fleetImportDetails.type, '%due%'),
            ilike(fleetImportDetails.type, '%manual payment%'),
          ),
          filters.scopePlates?.length
            ? filters.includeRawManual
              ? or(
                  inArray(fleetImportDetails.vehiclePlateNorm, filters.scopePlates),
                  and(
                    eq(fleetImportDetails.vehiclePlateNorm, ''),
                    ilike(fleetImportDetails.type, '%manual payment%'),
                  ),
                )
              : inArray(fleetImportDetails.vehiclePlateNorm, filters.scopePlates)
            : undefined,
        ),
      );

    // ── pivot (legacy grouping loop) ─────────────────────────────────────
    const pivot = new Map<string, GojekVehicleRow & { maxDay: number }>();
    // "Data Mentah Tanpa Plat" queue: unplated manual payments stay OUT of the
    // pivot (and every total) until an admin assigns them a plate.
    const rawManualRows: RawManualRow[] = [];

    for (const row of rawRows) {
      const day = Number(row.transactionDate.slice(8, 10));
      const isManual = this.isManualPaymentType(row.type);
      const plateKey = row.vehiclePlateNorm ?? normalizePlate(row.vehiclePlate);
      if (!plateKey && isManual) {
        rawManualRows.push({
          detailId: row.id,
          transactionDate: row.transactionDate,
          driverName: (row.driverName ?? '').trim(),
          amount: Math.abs(row.amount ?? 0),
          isManualPaymentSetoran: row.isManualPaymentSetoran,
          note: row.manualPaymentNote,
        });
        continue;
      }

      let v = pivot.get(plateKey);
      if (!v) {
        v = {
          key: plateKey,
          detailId: null, // synthetic manual_ rows now live in rawRows, not the pivot
          driverName: (row.driverName ?? '').toUpperCase(),
          driverHistory: [],
          vehicle: row.vehiclePlateNorm ?? normalizePlate(row.vehiclePlate),
          rentalPartner: '',
          deliveryBatch: '',
          serviceArea: '',
          vehicleType: '',
          regionId: null,
          plateNotFound: true,
          targetId: null,
          dailyData: {},
          dailyCountedData: {},
          dailyDue: {},
          dueSegments: [],
          dailyDetails: {},
          manualPaymentDays: [],
          manualPaymentDisplayOnlyDays: [],
          exceptions: {},
          totalDeduction: 0,
          totalDisplayAmount: 0,
          totalDue: 0,
          dueCount: 0,
          dailyTarget: 0,
          calculatedTarget: 0,
          activeDays: 0,
          minDay: 31,
          maxDay: 1,
          outstanding: 0,
          outstandingMonth: 0,
          isExited: false,
          exitedLastSeen: null,
        };
        pivot.set(plateKey, v);
      }

      const currentDriver = (row.driverName ?? '').trim();
      if (currentDriver && !v.driverHistory.includes(currentDriver)) {
        v.driverHistory.push(currentDriver);
      }
      if (currentDriver) v.driverName = currentDriver; // legacy: latest name wins

      v.dailyData[day] ??= 0;
      v.dailyCountedData[day] ??= 0;

      const amount = row.amount ?? 0;
      if (this.isDueType(row.type)) {
        v.totalDue += amount;
        v.dueCount++;
        v.dailyDue[day] = (v.dailyDue[day] ?? 0) + Math.abs(amount);
        if (day < v.minDay) v.minDay = day;
        if (day > v.maxDay) v.maxDay = day;
      } else if (this.isDeductionType(row.type) || isManual) {
        const val = Math.abs(amount);
        const counted = this.isManualPaymentCounted(row.type, row.isManualPaymentSetoran);
        const countedVal = isManual ? (counted ? val : 0) : val;
        const label = this.buildBreakdownLabel(row.type, isManual, counted);

        v.dailyData[day] += val;
        v.dailyCountedData[day] += countedVal;
        v.totalDisplayAmount += val;
        v.totalDeduction += countedVal;

        // legacy: only counted money moves the active range
        if (countedVal > 0) {
          if (day < v.minDay) v.minDay = day;
          if (day > v.maxDay) v.maxDay = day;
        }

        const note = !counted && row.manualPaymentNote ? row.manualPaymentNote : '';
        this.addBreakdownItem(
          v,
          day,
          label,
          val,
          countedVal,
          isManual && !counted,
          note,
          isManual ? row.id : null,
        );

        if (isManual) {
          if (!v.manualPaymentDays.includes(day)) v.manualPaymentDays.push(day);
          if (!counted && !v.manualPaymentDisplayOnlyDays.includes(day)) {
            v.manualPaymentDisplayOnlyDays.push(day);
          }
        }
      }
    }

    // ── targets, exceptions, all-time stats ─────────────────────────────
    const targets = await db.select().from(fleetTargets);

    const exceptionsRows = await db
      .select()
      .from(fleetExceptions)
      .where(
        and(
          sql`EXTRACT(MONTH FROM ${fleetExceptions.exceptionDate}) = ${month}`,
          sql`EXTRACT(YEAR FROM ${fleetExceptions.exceptionDate}) = ${year}`,
        ),
      );
    const exceptionsMap = new Map<
      string,
      Map<number, { keterangan: string | null; isBebasSetoran: boolean }>
    >();
    for (const e of exceptionsRows) {
      const plate = normalizePlate(e.vehiclePlate);
      const d = Number(e.exceptionDate.slice(8, 10));
      if (!exceptionsMap.has(plate)) exceptionsMap.set(plate, new Map());
      exceptionsMap.get(plate)!.set(d, {
        keterangan: e.keterangan,
        isBebasSetoran: e.isBebasSetoran,
      });
    }

    // Rental Monitoring bookings mark their days exactly like bebas-setoran
    // exceptions (legacy parity: jadwal-mobil-cogs wrote is_bebas_setoran=1
    // day rows into the same table). Explicit fleet_exceptions win on clash.
    const mm = String(month).padStart(2, '0');
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthStart = `${year}-${mm}-01`;
    const monthEnd = `${year}-${mm}-${String(lastDayOfMonth).padStart(2, '0')}`;
    const rentalRows = await db
      .select({
        plateNorm: rentals.plateNumberNorm,
        startDate: rentals.startDate,
        endDate: rentals.endDate,
        customerName: rentals.customerName,
      })
      .from(rentals)
      .where(and(lte(rentals.startDate, monthEnd), gte(rentals.endDate, monthStart)));
    for (const r of rentalRows) {
      const from = r.startDate < monthStart ? 1 : Number(r.startDate.slice(8, 10));
      const to = r.endDate > monthEnd ? lastDayOfMonth : Number(r.endDate.slice(8, 10));
      if (!exceptionsMap.has(r.plateNorm)) exceptionsMap.set(r.plateNorm, new Map());
      const perDay = exceptionsMap.get(r.plateNorm)!;
      for (let d = from; d <= to; d++) {
        if (!perDay.has(d)) {
          perDay.set(d, {
            keterangan: r.customerName ? `Rental — ${r.customerName}` : 'Rental',
            isBebasSetoran: true,
          });
        }
      }
    }

    const pivotPlates = [
      ...new Set([...pivot.values()].map((v) => v.vehicle).filter((p) => p !== '')),
    ];
    const [cumulativeMap, exitStats] = await Promise.all([
      this.fetchCumulativeStats(pivotPlates, month, year),
      this.fetchExitStats(filters.scopePlates),
    ]);

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    // ── per-vehicle target + outstanding (legacy loop, ported 1:1) ───────
    for (const [key, v] of pivot) {
      let manualTarget = 0;
      const plateClean = v.vehicle;

      for (const t of targets) {
        const tClean = t.vehiclePlateNorm || normalizePlate(t.vehiclePlate);
        if (tClean !== '' && plateClean !== '') {
          // legacy: exact OR substring match in either direction, first hit wins
          if (tClean === plateClean || tClean.includes(plateClean) || plateClean.includes(tClean)) {
            manualTarget = t.fleetTarget ?? 0;
            v.targetId = t.id;
            v.rentalPartner = t.rentalPartner ?? '';
            v.deliveryBatch = t.deliveryBatch ?? '';
            v.serviceArea = t.serviceArea ?? '';
            v.vehicleType = t.vehicleType ?? '';
            if (t.regionId) v.regionId = t.regionId;
            v.plateNotFound = false;
            break;
          }
        }
      }

      // Rental Partner syncs from the partner who registered the plate; the
      // admin-entered fleet_targets string is only a fallback for plates that
      // predate registration.
      const registeredPartner = filters.partnerNameByNorm?.get(plateClean);
      if (registeredPartner) v.rentalPartner = registeredPartner;

      let dailyTarget =
        manualTarget > 0
          ? manualTarget
          : v.dueCount > 0
            ? Math.round(v.totalDue / v.dueCount)
            : DEFAULT_DAILY_TARGET;
      if (dailyTarget === 0) dailyTarget = DEFAULT_DAILY_TARGET;

      let minDay = v.minDay <= 31 ? v.minDay : 1;
      const maxDay = v.maxDay >= 1 ? v.maxDay : 1;
      if (minDay > maxDay) minDay = maxDay;
      const activeDays = maxDay - minDay + 1;

      // exceptions: spreadsheet money wins; bebas-setoran days in range shrink target
      let exceptionDaysFreeCount = 0;
      const plateExceptions = exceptionsMap.get(plateClean);
      if (plateExceptions) {
        for (const [d, exc] of plateExceptions) {
          const hasAmount = (v.dailyData[d] ?? 0) > 0;
          if (!hasAmount) {
            v.exceptions[d] = exc;
            if (exc.isBebasSetoran && d >= minDay && d <= daysInMonth) {
              exceptionDaysFreeCount++;
            }
          }
        }
      }

      const remainingDays = daysInMonth - minDay + 1;
      const targetDays = Math.max(0, remainingDays - exceptionDaysFreeCount);

      v.dailyTarget = dailyTarget;
      v.calculatedTarget = dailyTarget * targetDays;
      v.activeDays = activeDays;
      v.minDay = minDay;

      // Outstanding = running balance (Σ due − Σ paid) from the plate's first
      // imported row up to the end of the SELECTED month; outstandingMonth is
      // the selected month's own slice of that window. Both counted and
      // uncounted manual payments settle the debt (the setoran flag only
      // controls whether the money counts toward the month's omset).
      const cum = cumulativeMap.get(key);
      v.outstanding = (cum?.cumulativeTarget ?? 0) - (cum?.cumulativePaid ?? 0);
      v.outstandingMonth = (cum?.monthTarget ?? 0) - (cum?.monthPaid ?? 0);

      const exit = exitStats.exitedByPlate.get(plateClean);
      if (exit) {
        v.isExited = true;
        v.exitedLastSeen = exit.lastSeen;
      }

      v.dueSegments = encodeDueSegments(v.dailyDue);
    }

    // ── available filters (computed BEFORE filtering, like legacy) ───────
    const allRows = [...pivot.values()];
    const availableRentalPartners = [
      ...new Set(allRows.map((r) => r.rentalPartner).filter((p) => p !== '')),
      NO_RENTAL_PARTNER,
    ].sort();

    let rows = allRows;
    if (filters.rentalPartners?.length) {
      rows = rows.filter((r) => {
        if (filters.rentalPartners!.includes(NO_RENTAL_PARTNER) && r.rentalPartner === '')
          return true;
        return filters.rentalPartners!.includes(r.rentalPartner);
      });
    }

    // performers computed over the rental-partner-filtered set (legacy order)
    const { topPerformers, bottomPerformers } = this.buildPerformers(rows);

    const availablePlatesMap = new Map<string, { plate: string; type: string }>();
    for (const r of rows) {
      if (r.vehicle && !availablePlatesMap.has(r.vehicle)) {
        availablePlatesMap.set(r.vehicle, { plate: r.vehicle, type: r.vehicleType });
      }
    }
    const availablePlates = [...availablePlatesMap.values()].sort((a, b) =>
      a.plate.localeCompare(b.plate),
    );

    if (filters.plates?.length) {
      rows = rows.filter((r) => filters.plates!.includes(r.vehicle));
    }
    // FilterBar free-text plate search (substring on the normalized plate).
    const plateQuery = normalizePlate(filters.plate);
    if (plateQuery) {
      rows = rows.filter((r) => r.vehicle.includes(plateQuery));
    }

    // legacy strcmp order: rental_partner then driver_name (region_name
    // tiebreaker is intentionally dropped — region resolution is out of R1 scope)
    rows.sort(
      (a, b) =>
        byteCompare(a.rentalPartner, b.rentalPartner) || byteCompare(a.driverName, b.driverName),
    );

    // table totals over the fully filtered set (legacy table_* values)
    const dailyTotals: Record<number, number> = {};
    for (let d = 1; d <= 31; d++) dailyTotals[d] = 0;
    let totalDeduction = 0;
    let totalCalculatedTarget = 0;
    let totalOutstanding = 0;
    let totalOutstandingMonth = 0;
    for (const r of rows) {
      totalDeduction += r.totalDeduction;
      totalCalculatedTarget += r.calculatedTarget;
      // exited plates report under outstandingDriverKeluar, not the main total
      if (!r.isExited) {
        totalOutstanding += r.outstanding;
        totalOutstandingMonth += r.outstandingMonth;
      }
      for (const [d, val] of Object.entries(r.dailyCountedData)) {
        dailyTotals[Number(d)] = (dailyTotals[Number(d)] ?? 0) + val;
      }
    }

    return {
      month,
      year,
      daysInMonth,
      rows: rows.map((r) => {
        const { maxDay, ...rest } = r;
        void maxDay; // internal working field, not part of the API shape
        return rest;
      }),
      dailyTotals,
      totalDeduction,
      totalCalculatedTarget,
      totalOutstanding,
      totalOutstandingMonth,
      rawRows: rawManualRows.sort(
        (a, b) => byteCompare(a.transactionDate, b.transactionDate) || a.detailId - b.detailId,
      ),
      rawTotalAmount: rawManualRows.reduce((sum, r) => sum + r.amount, 0),
      outstandingDriverKeluar: exitStats.outstandingDriverKeluar,
      exitedCount: exitStats.exitedCount,
      exitedDrivers: exitStats.exitedDrivers,
      lastImportDate: exitStats.lastImportDate,
      availableRentalPartners,
      availablePlates,
      topPerformers,
      bottomPerformers,
    };
  }

  /** Zeroed grid — a partner with no registered plates sees Rp 0 everywhere. */
  private emptyGrid(month: number, year: number): GojekGridResult {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dailyTotals: Record<number, number> = {};
    for (let d = 1; d <= 31; d++) dailyTotals[d] = 0;
    return {
      month,
      year,
      daysInMonth,
      rows: [],
      dailyTotals,
      totalDeduction: 0,
      totalCalculatedTarget: 0,
      totalOutstanding: 0,
      totalOutstandingMonth: 0,
      rawRows: [],
      rawTotalAmount: 0,
      outstandingDriverKeluar: 0,
      exitedCount: 0,
      exitedDrivers: [],
      lastImportDate: null,
      availableRentalPartners: [NO_RENTAL_PARTNER],
      availablePlates: [],
      topPerformers: [],
      bottomPerformers: [],
    };
  }

  async getCell(
    month: number,
    year: number,
    plateKey: string,
    day: number,
    scopePlates?: string[],
  ): Promise<DailyDetailBucket | null> {
    const grid = await this.buildGrid(month, year, { scopePlates });
    const row = grid.rows.find((r) => r.key === plateKey);
    return row?.dailyDetails[day] ?? null;
  }

  private addBreakdownItem(
    v: GojekVehicleRow,
    day: number,
    label: string,
    displayAmount: number,
    countedAmount: number,
    isDisplayOnly: boolean,
    note: string,
    detailId: number | null = null,
  ): void {
    const bucket = (v.dailyDetails[day] ??= {
      items: [],
      displayTotal: 0,
      countedTotal: 0,
      hasDisplayOnlyManualPayment: false,
    });
    let item = bucket.items.find((i) => i.label === label);
    if (!item) {
      item = { label, displayAmount: 0, countedAmount: 0, isDisplayOnly, note: '', detailIds: [] };
      bucket.items.push(item);
    }
    item.displayAmount += displayAmount;
    item.countedAmount += countedAmount;
    if (note !== '' && item.note === '') item.note = note;
    if (detailId !== null) item.detailIds.push(detailId);
    bucket.displayTotal += displayAmount;
    bucket.countedTotal += countedAmount;
    if (isDisplayOnly) bucket.hasDisplayOnlyManualPayment = true;
  }

  private buildPerformers(rows: GojekVehicleRow[]): {
    topPerformers: GojekPerformer[];
    bottomPerformers: GojekPerformer[];
  } {
    const byDriver = new Map<string, GojekPerformer & { plates: string[] }>();
    for (const r of rows) {
      const name = r.driverName || 'Unknown Driver';
      let p = byDriver.get(name);
      if (!p) {
        p = { driverName: name, vehicle: '', plates: [], totalDeduction: 0, outstanding: 0 };
        byDriver.set(name, p);
      }
      if (!p.plates.includes(r.vehicle)) p.plates.push(r.vehicle);
      p.totalDeduction += r.totalDeduction;
      p.outstanding += r.outstanding;
    }
    const performers = [...byDriver.values()].map(({ plates, ...p }) => ({
      ...p,
      vehicle: plates.filter((x) => x.trim() !== '').join(', '),
    }));

    const top = [...performers].sort((a, b) => a.outstanding - b.outstanding).slice(0, 10);
    const bottom = [...performers].sort((a, b) => b.outstanding - a.outstanding).slice(0, 10);
    return { topPerformers: top, bottomPerformers: bottom };
  }

  /**
   * Driver-keluar detection + balance (ported from the legacy
   * fetchExitedFleetOutstanding). A plate is exited when its all-time last
   * transaction date is older than the newest import date ANYWHERE — the
   * reference is the latest upload, so it stays global even under partner
   * scoping (a partner whose whole fleet left still sees every exit). A plate
   * that reappears in a later import stops matching automatically (MAX moves).
   *
   * The balance is the plate's ALL-TIME due − paid (deduction + manual payment,
   * regardless of the counted flag — an exited driver's debt is a "now" fact),
   * skipping bebas-setoran exception days. exitedCount counts only plates whose
   * balance is non-zero, matching the legacy card. exitedDrivers is the card's
   * click-through detail: one row per exited plate that still carries a
   * balance (driver name taken from the plate's last import rows), sorted by
   * outstanding descending like the legacy modal.
   */
  private async fetchExitStats(scopePlates?: string[]): Promise<{
    exitedByPlate: Map<string, { lastSeen: string; outstanding: number }>;
    outstandingDriverKeluar: number;
    exitedCount: number;
    exitedDrivers: ExitedDriver[];
    lastImportDate: string | null; // newest transaction date anywhere (modal subtitle)
  }> {
    const empty = {
      exitedByPlate: new Map(),
      outstandingDriverKeluar: 0,
      exitedCount: 0,
      exitedDrivers: [],
      lastImportDate: null,
    };
    if (scopePlates !== undefined && scopePlates.length === 0) return empty;

    const scopeFilter = scopePlates?.length
      ? sql`AND vehicle_plate_norm IN (${sql.join(
          scopePlates.map((p) => sql`${p}`),
          sql`, `,
        )})`
      : sql``;

    const lastSeenRows = (await this.database.db.execute(sql`
      SELECT
        vehicle_plate_norm AS plate,
        MAX(transaction_date)::text AS last_seen,
        (SELECT MAX(transaction_date)::text FROM fleet_import_details) AS global_last
      FROM fleet_import_details
      WHERE vehicle_plate_norm <> '' ${scopeFilter}
      GROUP BY vehicle_plate_norm
    `)) as unknown as Array<{ plate: string; last_seen: string; global_last: string }>;

    const lastImportDate = lastSeenRows[0]?.global_last ?? null;
    const exitedByPlate = new Map<string, { lastSeen: string; outstanding: number }>();
    for (const row of lastSeenRows) {
      if (row.last_seen < row.global_last) {
        exitedByPlate.set(row.plate, { lastSeen: row.last_seen, outstanding: 0 });
      }
    }
    if (!exitedByPlate.size) return { ...empty, lastImportDate };

    const balanceRows = (await this.database.db.execute(sql`
      SELECT
        d.vehicle_plate_norm AS plate,
        SUM(CASE WHEN d.type ILIKE '%due%' THEN ABS(d.amount) ELSE 0 END)::bigint AS target_sum,
        SUM(CASE
            WHEN d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%' THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS paid_sum
      FROM fleet_import_details d
      WHERE (d.type ILIKE '%due%' OR d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%')
        AND d.vehicle_plate_norm IN (${sql.join(
          [...exitedByPlate.keys()].map((p) => sql`${p}`),
          sql`, `,
        )})
        AND NOT EXISTS (
          SELECT 1 FROM fleet_exceptions e
          WHERE e.is_bebas_setoran = TRUE
            AND e.exception_date = d.transaction_date
            AND regexp_replace(upper(e.vehicle_plate), '[^A-Z0-9]', '', 'g') = d.vehicle_plate_norm
        )
      GROUP BY d.vehicle_plate_norm
    `)) as unknown as Array<{ plate: string; target_sum: string; paid_sum: string }>;

    let outstandingDriverKeluar = 0;
    let exitedCount = 0;
    for (const row of balanceRows) {
      const outstanding = Number(row.target_sum) - Number(row.paid_sum);
      exitedByPlate.get(row.plate)!.outstanding = outstanding;
      outstandingDriverKeluar += outstanding;
      if (outstanding !== 0) exitedCount++;
    }

    // Newest row per exited plate → the driver name it left with.
    const nameRows = (await this.database.db.execute(sql`
      SELECT DISTINCT ON (vehicle_plate_norm)
        vehicle_plate_norm AS plate,
        driver_name
      FROM fleet_import_details
      WHERE vehicle_plate_norm IN (${sql.join(
        [...exitedByPlate.keys()].map((p) => sql`${p}`),
        sql`, `,
      )})
      ORDER BY vehicle_plate_norm, transaction_date DESC, id DESC
    `)) as unknown as Array<{ plate: string; driver_name: string | null }>;
    const nameByPlate = new Map(nameRows.map((r) => [r.plate, r.driver_name]));

    const exitedDrivers = [...exitedByPlate.entries()]
      .filter(([, e]) => e.outstanding !== 0)
      .map(([plate, e]) => ({
        driverName: (nameByPlate.get(plate) ?? '').trim().toUpperCase() || 'Unknown Driver',
        plate,
        lastSeen: e.lastSeen,
        outstanding: e.outstanding,
      }))
      .sort((a, b) => b.outstanding - a.outstanding);

    return { exitedByPlate, outstandingDriverKeluar, exitedCount, exitedDrivers, lastImportDate };
  }

  /**
   * Cumulative outstanding window (port of the legacy fetchCumulativeStats).
   * Per plate: Σ|due| (billed) vs Σ|deduction + manual payment| (paid) over ALL
   * history strictly BEFORE the first day of the month AFTER the selected one —
   * no lower bound, so the balance accumulates from the plate's very first
   * imported row, and a past month shows the balance as it stood back then.
   * The month_* columns are the selected month's own slice of the same window,
   * so outstanding(prev month) + outstandingMonth === outstanding by construction.
   * Bebas-setoran days — explicit fleet_exceptions and Rental Monitoring
   * bookings — are excluded from BOTH sides: not billed, not credited.
   */
  private async fetchCumulativeStats(
    plates: string[],
    month: number,
    year: number,
  ): Promise<
    Map<
      string,
      { cumulativeTarget: number; cumulativePaid: number; monthTarget: number; monthPaid: number }
    >
  > {
    const map = new Map<
      string,
      { cumulativeTarget: number; cumulativePaid: number; monthTarget: number; monthPaid: number }
    >();
    if (!plates.length) return map;

    const periodStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const periodEndExclusive = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const result = await this.database.db.execute(sql`
      SELECT
        d.vehicle_plate_norm AS plate,
        SUM(CASE WHEN d.type ILIKE '%due%' THEN ABS(d.amount) ELSE 0 END)::bigint AS cum_target,
        SUM(CASE
            WHEN d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%' THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS cum_paid,
        SUM(CASE
            WHEN d.transaction_date >= ${periodStart}::date AND d.type ILIKE '%due%' THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS month_target,
        SUM(CASE
            WHEN d.transaction_date >= ${periodStart}::date
             AND (d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%') THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS month_paid
      FROM fleet_import_details d
      WHERE d.transaction_date < ${periodEndExclusive}::date
        AND (d.type ILIKE '%due%' OR d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%')
        AND d.vehicle_plate_norm IN (${sql.join(
          plates.map((p) => sql`${p}`),
          sql`, `,
        )})
        AND NOT EXISTS (
          SELECT 1 FROM fleet_exceptions e
          WHERE e.is_bebas_setoran = TRUE
            AND e.exception_date = d.transaction_date
            AND regexp_replace(upper(e.vehicle_plate), '[^A-Z0-9]', '', 'g') = d.vehicle_plate_norm
        )
        AND NOT EXISTS (
          SELECT 1 FROM rentals r
          WHERE r.plate_number_norm = d.vehicle_plate_norm
            AND d.transaction_date BETWEEN r.start_date AND r.end_date
        )
      GROUP BY d.vehicle_plate_norm
    `);

    for (const row of result as unknown as Array<Record<string, unknown>>) {
      map.set(String(row.plate), {
        cumulativeTarget: Number(row.cum_target),
        cumulativePaid: Number(row.cum_paid),
        monthTarget: Number(row.month_target),
        monthPaid: Number(row.month_paid),
      });
    }
    return map;
  }
}
