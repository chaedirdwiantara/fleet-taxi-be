import { Injectable } from '@nestjs/common';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { fleetExceptions, fleetImportDetails, fleetTargets } from '../db/schema';
import {
  DEFAULT_DAILY_TARGET,
  DailyDetailBucket,
  GojekGridResult,
  GojekPerformer,
  GojekVehicleRow,
  NO_RENTAL_PARTNER,
} from './gojek-grid.types';

/**
 * Faithful port of legacy AdminFleetMonitoringController::getIndex.
 * The monthly pivot runs in TypeScript exactly like the legacy PHP loop
 * (≤ ~500 vehicles × 31 days per month — small); the all-time outstanding
 * aggregation is the same SQL the legacy used, keyed on vehicle_plate_norm.
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
    filters: { rentalPartners?: string[]; plates?: string[] } = {},
  ): Promise<GojekGridResult> {
    const { db } = this.database;

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
        ),
      );

    // ── pivot (legacy grouping loop) ─────────────────────────────────────
    const pivot = new Map<string, GojekVehicleRow & { maxDay: number }>();

    for (const row of rawRows) {
      const day = Number(row.transactionDate.slice(8, 10));
      const isManual = this.isManualPaymentType(row.type);
      let plateKey = row.vehiclePlateNorm ?? normalizePlate(row.vehiclePlate);
      if (!plateKey && isManual) plateKey = `manual_${row.id}`;

      let v = pivot.get(plateKey);
      if (!v) {
        v = {
          key: plateKey,
          detailId: plateKey.startsWith('manual_') ? row.id : null,
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
        this.addBreakdownItem(v, day, label, val, countedVal, isManual && !counted, note);

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

    const allTimeMap = await this.fetchAllTimeStats([
      ...new Set([...pivot.values()].map((v) => v.vehicle).filter((p) => p !== '')),
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

      // legacy: all-time stats looked up by the pivot key (manual_ keys miss → zeros)
      const at = allTimeMap.get(key);
      const allTimeDays = at?.allTimeDays ?? 0;
      const allTimeDeduction = at?.allTimeDeduction ?? 0;
      const allTimeManualUncounted = at?.allTimeManualUncounted ?? 0;
      v.outstanding = dailyTarget * allTimeDays - allTimeDeduction - allTimeManualUncounted;
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

    rows.sort(
      (a, b) =>
        a.rentalPartner.localeCompare(b.rentalPartner) || a.driverName.localeCompare(b.driverName),
    );

    // table totals over the fully filtered set (legacy table_* values)
    const dailyTotals: Record<number, number> = {};
    for (let d = 1; d <= 31; d++) dailyTotals[d] = 0;
    let totalDeduction = 0;
    let totalCalculatedTarget = 0;
    let totalOutstanding = 0;
    for (const r of rows) {
      totalDeduction += r.totalDeduction;
      totalCalculatedTarget += r.calculatedTarget;
      totalOutstanding += r.outstanding;
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
      availableRentalPartners,
      availablePlates,
      topPerformers,
      bottomPerformers,
    };
  }

  async getCell(
    month: number,
    year: number,
    plateKey: string,
    day: number,
  ): Promise<DailyDetailBucket | null> {
    const grid = await this.buildGrid(month, year);
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
  ): void {
    const bucket = (v.dailyDetails[day] ??= {
      items: [],
      displayTotal: 0,
      countedTotal: 0,
      hasDisplayOnlyManualPayment: false,
    });
    let item = bucket.items.find((i) => i.label === label);
    if (!item) {
      item = { label, displayAmount: 0, countedAmount: 0, isDisplayOnly, note: '' };
      bucket.items.push(item);
    }
    item.displayAmount += displayAmount;
    item.countedAmount += countedAmount;
    if (note !== '' && item.note === '') item.note = note;
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

  /** Same aggregation the legacy ran in SQL, keyed on vehicle_plate_norm. */
  private async fetchAllTimeStats(
    plates: string[],
  ): Promise<
    Map<string, { allTimeDeduction: number; allTimeDays: number; allTimeManualUncounted: number }>
  > {
    const map = new Map<
      string,
      { allTimeDeduction: number; allTimeDays: number; allTimeManualUncounted: number }
    >();
    if (!plates.length) return map;

    const result = await this.database.db.execute(sql`
      SELECT
        vehicle_plate_norm AS plate,
        SUM(CASE
            WHEN type ILIKE '%deduction%' THEN ABS(amount)
            WHEN type ILIKE '%manual payment%' AND COALESCE(is_manual_payment_setoran, 1) = 1 THEN ABS(amount)
            ELSE 0
        END)::bigint AS all_time_deduction,
        COUNT(DISTINCT CASE WHEN type ILIKE '%deduction%' THEN transaction_date END)::int AS all_time_days,
        SUM(CASE
            WHEN type ILIKE '%manual payment%' AND COALESCE(is_manual_payment_setoran, 1) = 0 THEN ABS(amount)
            ELSE 0
        END)::bigint AS all_time_manual_uncounted
      FROM fleet_import_details
      WHERE (type ILIKE '%deduction%' OR type ILIKE '%manual payment%')
        AND vehicle_plate_norm IN (${sql.join(
          plates.map((p) => sql`${p}`),
          sql`, `,
        )})
      GROUP BY vehicle_plate_norm
    `);

    for (const row of result as unknown as Array<Record<string, unknown>>) {
      map.set(String(row.plate), {
        allTimeDeduction: Number(row.all_time_deduction),
        allTimeDays: Number(row.all_time_days),
        allTimeManualUncounted: Number(row.all_time_manual_uncounted),
      });
    }
    return map;
  }
}
