import { Injectable } from '@nestjs/common';
import { SQL, and, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { driverRowKey, type MonitoringMode } from '../common/util/monitoring-mode';
import { clampDayWindow, type DayWindow } from '../common/util/period';
import { normalizePlate } from '../common/util/plate';
import { byteCompare } from '../common/util/sort';
import { DatabaseService } from '../db/database.service';
import { normalizeDriverName } from '../partner-drivers/driver.constants';
import { fleetExceptions, fleetImportDetails, fleetTargets, rentals } from '../db/schema';
import { encodeDueSegments } from './due-segments';
import {
  DailyDetailBucket,
  ExitedDriver,
  GojekGridResult,
  GojekVehicleRow,
  NO_RENTAL_PARTNER,
  RawManualRow,
} from './gojek-grid.types';
import { billedWindow, dailyTargetFrom } from './target-window';

/**
 * Grouping key of the two history-spanning SQL aggregates. Both are already
 * row-wise (every exclusion tests the row's own plate + date), so reading the
 * grid per driver instead of per plate is exactly this expression changing —
 * the money each row sums stays the same, which is why every table total is
 * identical in both modes.
 */
const PLATE_KEY_SQL = sql`d.vehicle_plate_norm`;
// Must stay character-for-character equivalent to normalizeDriverName() — the
// TS pivot and this aggregate have to agree on who is one person. The `\\s` is a
// JS-escaped backslash: the SQL text needs a literal `\s+`.
// COALESCE keeps nameless rows in one '' bucket instead of a NULL group, so
// their money stays visible (and matches driverRowKey('') === 'drv:').
const DRIVER_KEY_SQL = sql`upper(regexp_replace(btrim(COALESCE(d.driver_name, '')), '\\s+', ' ', 'g'))`;
const keySql = (mode: MonitoringMode): SQL => (mode === 'driver' ? DRIVER_KEY_SQL : PLATE_KEY_SQL);

/** One row subject's slices of the history-spanning due/paid aggregate. */
interface CumulativeStats {
  cumulativeTarget: number;
  cumulativePaid: number;
  monthTarget: number;
  monthPaid: number;
  // Only present when a day window was requested (see DayWindow).
  monthTargetToDay?: number;
  monthPaidToDay?: number;
  windowTarget?: number;
  windowPaid?: number;
}

/**
 * Faithful port of legacy AdminFleetMonitoringController::buildMonitoringData.
 * The monthly pivot runs in TypeScript exactly like the legacy PHP loop
 * (≤ ~500 vehicles × 31 days per month — small); the cumulative outstanding
 * window (fetchCumulativeStats) is one SQL aggregate keyed on vehicle_plate_norm
 * (or on the driver identity in `mode: 'driver'`).
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
      // Free-text search over the two identities a reader knows a row by: its
      // plate and its driver. One box for both, so the reader never has to say
      // which of the two they typed.
      q?: string;
      // "Tipe Kendaraan" filter, matched against the plate's resolved Type (see
      // vehicleTypeByNorm). A row is kept when ANY of its plates is of a
      // selected type — in driver mode that reads as "drove such a vehicle".
      vehicleTypes?: string[];
      // Server-derived norm → Type map (Daftarkan Plat). Fills the Type of every
      // plate no admin fleet_target typed, which is what makes the Type column,
      // the availablePlates payload and the vehicleTypes filter agree.
      vehicleTypeByNorm?: Map<string, string>;
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
      // This month's slice of the dashboard's Tanggal date-range filter: adds
      // the dayWindow aggregates bounded to those days. Whole-month figures are
      // unaffected. Out-of-range values are ignored.
      dayWindow?: DayWindow;
      // Row subject: one row per plate (default) or per driver. Driver mode
      // regroups the very same import rows, so every table total matches the
      // plate view exactly; only plate-level facts (fleet_targets, exception
      // markers, "Baru") are dropped because they describe a unit, not a person.
      mode?: MonitoringMode;
    } = {},
  ): Promise<GojekGridResult> {
    const { db } = this.database;
    const mode: MonitoringMode = filters.mode ?? 'plate';
    const byDriver = mode === 'driver';

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    // Clamp the optional Tanggal window once; everything below trusts it.
    const dayWindow = clampDayWindow(filters.dayWindow, daysInMonth);

    if (filters.scopePlates !== undefined && filters.scopePlates.length === 0) {
      return this.emptyGrid(month, year, mode, dayWindow);
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
    // duePlateDays: day → plates that carried a `due` row that day. Only used
    // to decide which days the cumulative SQL waived; stripped before returning.
    const pivot = new Map<
      string,
      GojekVehicleRow & { maxDay: number; duePlateDays: Map<number, Set<string>> }
    >();
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

      // The row subject: a plate, or the person who drove it. Everything below
      // accumulates into that bucket unchanged — same rows, different grouping.
      const rowKey = byDriver ? driverRowKey(row.driverName) : plateKey;

      let v = pivot.get(rowKey);
      if (!v) {
        v = {
          key: rowKey,
          detailId: null, // synthetic manual_ rows now live in rawRows, not the pivot
          driverName: byDriver
            ? normalizeDriverName(row.driverName ?? '')
            : (row.driverName ?? '').toUpperCase(),
          driverHistory: [],
          // A driver row spans plates, so it has no single `vehicle`; the plates
          // it did use are listed in plateHistory (the mirror of driverHistory).
          vehicle: byDriver ? '' : plateKey,
          plateHistory: [],
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
          billedDays: 0,
          billFromDay: null,
          billToDay: null,
          minDay: 31,
          maxDay: 1,
          duePlateDays: new Map(),
          outstanding: 0,
          outstandingMonth: 0,
          isExited: false,
          exitedLastSeen: null,
          firstSeen: null,
          isNewJoiner: false,
        };
        pivot.set(rowKey, v);
      }

      const currentDriver = (row.driverName ?? '').trim();
      if (currentDriver && !v.driverHistory.includes(currentDriver)) {
        v.driverHistory.push(currentDriver);
      }
      // legacy: latest name wins. In driver mode the name IS the row identity,
      // so it must stay the normalized one.
      if (currentDriver && !byDriver) v.driverName = currentDriver;
      if (plateKey && !v.plateHistory.includes(plateKey)) v.plateHistory.push(plateKey);

      v.dailyData[day] ??= 0;
      v.dailyCountedData[day] ??= 0;

      const amount = row.amount ?? 0;
      if (this.isDueType(row.type)) {
        v.totalDue += amount;
        v.dueCount++;
        v.dailyDue[day] = (v.dailyDue[day] ?? 0) + Math.abs(amount);
        const platesThatDay = v.duePlateDays.get(day);
        if (platesThatDay) platesThatDay.add(plateKey);
        else v.duePlateDays.set(day, new Set([plateKey]));
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

    // norm → Type, resolved once for every plate in the system: the admin
    // fleet_targets value wins, the Type the partner entered in Daftarkan Plat
    // fills the rest. Single definition of "a plate's Type", read by the Type
    // column, the availablePlates payload and the vehicleTypes filter alike —
    // previously each caller backfilled the column on its own after presenting,
    // which left driver-mode rows and the filter without any Type at all.
    const plateTypeByNorm = new Map<string, string>();
    for (const [norm, type] of filters.vehicleTypeByNorm ?? []) {
      if (type) plateTypeByNorm.set(norm, type);
    }
    for (const t of targets) {
      const norm = t.vehiclePlateNorm || normalizePlate(t.vehiclePlate);
      if (norm && t.vehicleType) plateTypeByNorm.set(norm, t.vehicleType);
    }
    // A plate row falls back to its own resolved column (the legacy fleet_targets
    // match is substring-based, so it can carry a Type this exact map has not).
    const typeOfPlate = (plate: string, row: GojekVehicleRow): string =>
      plateTypeByNorm.get(plate) ?? (byDriver ? '' : row.vehicleType);

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
    // Days the cumulative SQL waives, tracked independently of the marker map
    // above. The two rules genuinely differ: markers follow "spreadsheet money
    // wins" and an explicit exception overrides an overlapping rental, while
    // the SQL waives a day if EITHER source covers it, money or not. Deriving
    // the caption from the marker map would let it span days the amount was
    // never summed over.
    const waivedDaysByPlate = new Map<string, Set<number>>();
    const waive = (plate: string, day: number) => {
      const days = waivedDaysByPlate.get(plate);
      if (days) days.add(day);
      else waivedDaysByPlate.set(plate, new Set([day]));
    };
    for (const e of exceptionsRows) {
      const plate = normalizePlate(e.vehiclePlate);
      const d = Number(e.exceptionDate.slice(8, 10));
      if (!exceptionsMap.has(plate)) exceptionsMap.set(plate, new Map());
      exceptionsMap.get(plate)!.set(d, {
        keterangan: e.keterangan,
        isBebasSetoran: e.isBebasSetoran,
      });
      if (e.isBebasSetoran) waive(plate, d);
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
        // The SQL waives a rental day even when an explicit exception took the
        // marker slot above, so record it regardless.
        waive(r.plateNorm, d);
      }
    }

    // Keys of the history-spanning aggregates: plates, or driver identities.
    const pivotKeys = [
      ...new Set(
        [...pivot.values()]
          .map((v) => (byDriver ? v.driverName : v.vehicle))
          .filter((k) => k !== '' || byDriver),
      ),
    ];
    const [cumulativeMap, lifecycle] = await Promise.all([
      this.fetchCumulativeStats(pivotKeys, month, year, dayWindow, mode, filters.scopePlates),
      this.fetchLifecycle(mode, filters.scopePlates),
    ]);

    // ── per-row target + outstanding (legacy loop, ported 1:1) ───────────
    for (const v of pivot.values()) {
      let manualTarget = 0;
      const plateClean = v.vehicle;
      // Aggregate lookup key — the driver identity in driver mode, the plate
      // otherwise. Same value the SQL grouped on.
      const statsKey = byDriver ? v.driverName : plateClean;

      // fleet_targets is keyed by plate, so it only applies to plate rows. A
      // driver row derives its displayed rate from the dues it was actually
      // billed (dailyTargetFrom below) — a person has no fleet target.
      if (!byDriver) {
        for (const t of targets) {
          const tClean = t.vehiclePlateNorm || normalizePlate(t.vehiclePlate);
          if (tClean !== '' && plateClean !== '') {
            // legacy: exact OR substring match in either direction, first hit wins
            if (
              tClean === plateClean ||
              tClean.includes(plateClean) ||
              plateClean.includes(tClean)
            ) {
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
        // No admin fleet_target typed this plate → show what the partner
        // registered for it, so the monitoring screens agree with Daftarkan Plat.
        if (!v.vehicleType) v.vehicleType = plateTypeByNorm.get(plateClean) ?? '';
      }

      // Rental Partner syncs from the partner who registered the plate; the
      // admin-entered fleet_targets string is only a fallback for plates that
      // predate registration. A driver row takes the label of the last plate it
      // drove (latest-wins, like the driver name does in plate mode).
      if (byDriver) {
        for (const plate of v.plateHistory) {
          const name = filters.partnerNameByNorm?.get(plate);
          if (name) v.rentalPartner = name;
        }
      } else {
        const registeredPartner = filters.partnerNameByNorm?.get(plateClean);
        if (registeredPartner) v.rentalPartner = registeredPartner;
      }

      let minDay = v.minDay <= 31 ? v.minDay : 1;
      const maxDay = v.maxDay >= 1 ? v.maxDay : 1;
      if (minDay > maxDay) minDay = maxDay;

      // Exception markers: spreadsheet money wins, so a day that carries money
      // shows no marker. Unchanged — markers are a separate concern from the
      // waived-days set the caption uses. Plate rows only: "bebas setoran" and
      // "tidak beroperasi" are states of a vehicle, and a driver who switched
      // plates mid-day has no single state to show.
      const plateExceptions = byDriver ? undefined : exceptionsMap.get(plateClean);
      if (plateExceptions) {
        for (const [d, exc] of plateExceptions) {
          const hasAmount = (v.dailyData[d] ?? 0) > 0;
          if (!hasAmount) v.exceptions[d] = exc;
        }
      }

      // Outstanding = running balance (Σ due − Σ paid) from the plate's first
      // imported row up to the end of the SELECTED month; outstandingMonth is
      // the selected month's own slice of that window. Both counted and
      // uncounted manual payments settle the debt (the setoran flag only
      // controls whether the money counts toward the month's omset).
      const cum = cumulativeMap.get(statsKey);
      v.outstanding = (cum?.cumulativeTarget ?? 0) - (cum?.cumulativePaid ?? 0);
      v.outstandingMonth = (cum?.monthTarget ?? 0) - (cum?.monthPaid ?? 0);
      if (dayWindow !== undefined) {
        v.monthTargetToDay = cum?.monthTargetToDay ?? 0;
        v.monthPaidToDay = cum?.monthPaidToDay ?? 0;
        v.windowTarget = cum?.windowTarget ?? 0;
        v.windowPaid = cum?.windowPaid ?? 0;
      }

      // The obligation IS the billed dues — the same `month_target` slice that
      // produced outstandingMonth above, so the two columns can never disagree.
      // Nothing is extrapolated past what the import actually billed: days that
      // have not elapsed, have not been imported, or predate the plate's first
      // due row simply contribute nothing.
      v.dailyTarget = dailyTargetFrom(v.dailyDue, manualTarget);
      v.calculatedTarget = cum?.monthTarget ?? 0;
      // A day is waived only when EVERY plate that billed the row that day was
      // waived — precisely the rows the SQL dropped. In plate mode there is only
      // ever one such plate, so this reduces to the plate's own waived set.
      const waivedDays = new Set<number>();
      for (const [d, plates] of v.duePlateDays) {
        let allWaived = true;
        for (const plate of plates) {
          if (!waivedDaysByPlate.get(plate)?.has(d)) {
            allWaived = false;
            break;
          }
        }
        if (allWaived) waivedDays.add(d);
      }
      const window = billedWindow(v.dailyDue, waivedDays);
      v.billedDays = window.billedDays;
      v.billFromDay = window.billFromDay;
      v.billToDay = window.billToDay;
      v.minDay = minDay;

      // Lifecycle is keyed the same way as the money: a plate that stopped
      // appearing, or a driver who did. Both mean "Keluar" to the reader, and
      // keeping the key aligned keeps the exited/active split of the outstanding
      // total consistent between modes.
      const exit = lifecycle.exitedByKey.get(statsKey);
      if (exit) {
        v.isExited = true;
        v.exitedLastSeen = exit.lastSeen;
      }

      const firstSeen = lifecycle.firstSeenByKey.get(statsKey) ?? null;
      v.firstSeen = firstSeen;
      v.isNewJoiner = firstSeen !== null && firstSeen >= monthStart;

      v.dueSegments = encodeDueSegments(v.dailyDue);
    }

    // ── available filters (computed BEFORE filtering, like legacy) ───────
    const allRows = [...pivot.values()];
    const availableRentalPartners = [
      ...new Set(allRows.map((r) => r.rentalPartner).filter((p) => p !== '')),
      NO_RENTAL_PARTNER,
    ].sort();
    // Options of the "Tipe Kendaraan" filter. Computed over every row like the
    // rental-partner list above, so picking one type never drops the others
    // from the dropdown.
    const availableVehicleTypes = [
      ...new Set(
        allRows
          .flatMap((r) => r.plateHistory.map((p) => typeOfPlate(p, r)))
          .filter((t) => t !== ''),
      ),
    ].sort((a, b) => a.localeCompare(b));

    let rows = allRows;
    if (filters.rentalPartners?.length) {
      rows = rows.filter((r) => {
        if (filters.rentalPartners!.includes(NO_RENTAL_PARTNER) && r.rentalPartner === '')
          return true;
        return filters.rentalPartners!.includes(r.rentalPartner);
      });
    }

    // Plate options come from plateHistory, which is the row's own plate in
    // plate mode and every plate the person drove in driver mode — so the
    // dropdown keeps the same contents in both views.
    const availablePlatesMap = new Map<string, { plate: string; type: string }>();
    for (const r of rows) {
      for (const plate of r.plateHistory) {
        if (!availablePlatesMap.has(plate)) {
          availablePlatesMap.set(plate, { plate, type: typeOfPlate(plate, r) });
        }
      }
    }
    const availablePlates = [...availablePlatesMap.values()].sort((a, b) =>
      a.plate.localeCompare(b.plate),
    );

    if (filters.plates?.length) {
      rows = rows.filter((r) => r.plateHistory.some((p) => filters.plates!.includes(p)));
    }
    // FilterBar free-text plate search (substring on the normalized plate) —
    // matches any plate of the row, which in driver mode means "drove that plate".
    const plateQuery = normalizePlate(filters.plate);
    if (plateQuery) {
      rows = rows.filter((r) => r.plateHistory.some((p) => p.includes(plateQuery)));
    }

    // One search box over both identities: the query is normalized twice (as a
    // plate and as a name) and a row matches on either, so "b2449" and "chandra"
    // both work without the reader declaring which they typed.
    const searchPlate = normalizePlate(filters.q);
    const searchName = normalizeDriverName(filters.q ?? '');
    if (searchPlate || searchName) {
      rows = rows.filter(
        (r) =>
          (searchPlate !== '' && r.plateHistory.some((p) => p.includes(searchPlate))) ||
          (searchName !== '' &&
            (normalizeDriverName(r.driverName).includes(searchName) ||
              r.driverHistory.some((n) => normalizeDriverName(n).includes(searchName)))),
      );
    }

    const wantedTypes = new Set(
      (filters.vehicleTypes ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t !== ''),
    );
    if (wantedTypes.size) {
      rows = rows.filter((r) =>
        r.plateHistory.some((p) => wantedTypes.has(typeOfPlate(p, r).trim().toLowerCase())),
      );
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
    let totalOutstandingToDay = 0;
    let totalOutstandingMonthToDay = 0;
    let totalWindowDue = 0;
    let totalWindowDelta = 0;
    for (const r of rows) {
      totalDeduction += r.totalDeduction;
      totalCalculatedTarget += r.calculatedTarget;
      // Mirrors totalCalculatedTarget: the billed obligation, exited rows included.
      if (dayWindow !== undefined) totalWindowDue += r.windowTarget ?? 0;
      // exited plates report under outstandingDriverKeluar, not the main total
      if (!r.isExited) {
        totalOutstanding += r.outstanding;
        totalOutstandingMonth += r.outstandingMonth;
        if (dayWindow !== undefined) {
          // prior-months balance + the month's delta truncated at the window end
          const monthDeltaToDay = (r.monthTargetToDay ?? 0) - (r.monthPaidToDay ?? 0);
          totalOutstandingToDay += r.outstanding - r.outstandingMonth + monthDeltaToDay;
          totalOutstandingMonthToDay += monthDeltaToDay;
          totalWindowDelta += (r.windowTarget ?? 0) - (r.windowPaid ?? 0);
        }
      }
      for (const [d, val] of Object.entries(r.dailyCountedData)) {
        dailyTotals[Number(d)] = (dailyTotals[Number(d)] ?? 0) + val;
      }
    }

    return {
      month,
      year,
      daysInMonth,
      mode,
      rows: rows.map((r) => {
        const { maxDay, duePlateDays, ...rest } = r;
        void maxDay; // internal working fields, not part of the API shape
        void duePlateDays;
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
      outstandingDriverKeluar: lifecycle.outstandingDriverKeluar,
      exitedCount: lifecycle.exitedCount,
      exitedDrivers: lifecycle.exitedDrivers,
      lastImportDate: lifecycle.lastImportDate,
      availableRentalPartners,
      availablePlates,
      availableVehicleTypes,
      ...(dayWindow !== undefined
        ? {
            dayWindow: {
              ...dayWindow,
              totalOutstandingToDay,
              totalOutstandingMonthToDay,
              totalWindowDue,
              totalWindowDelta,
            },
          }
        : {}),
    };
  }

  /** Zeroed grid — a partner with no registered plates sees Rp 0 everywhere. */
  private emptyGrid(
    month: number,
    year: number,
    mode: MonitoringMode,
    dayWindow?: DayWindow,
  ): GojekGridResult {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dailyTotals: Record<number, number> = {};
    for (let d = 1; d <= 31; d++) dailyTotals[d] = 0;
    return {
      month,
      year,
      daysInMonth,
      mode,
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
      availableVehicleTypes: [],
      ...(dayWindow !== undefined
        ? {
            dayWindow: {
              ...dayWindow,
              totalOutstandingToDay: 0,
              totalOutstandingMonthToDay: 0,
              totalWindowDue: 0,
              totalWindowDelta: 0,
            },
          }
        : {}),
    };
  }

  /** One row's day breakdown. `rowKey` is a normalized plate, or `drv:<NAME>`
   * when the caller is reading the grid per driver. */
  async getCell(
    month: number,
    year: number,
    rowKey: string,
    day: number,
    scopePlates?: string[],
    mode: MonitoringMode = 'plate',
  ): Promise<DailyDetailBucket | null> {
    const grid = await this.buildGrid(month, year, { scopePlates, mode });
    const row = grid.rows.find((r) => r.key === rowKey);
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

  /**
   * Lifecycle per row subject: when it first appeared, and whether it has since
   * left. Keyed by plate (`mode: 'plate'`) or by driver identity — the same
   * expression the money aggregate groups on, so the exited/active split of the
   * outstanding total means the same thing in both views.
   *
   * FIRST SEEN is the subject's oldest transaction date across all history. One
   * whose first date falls inside the selected month is a new joiner — a label
   * only, since it owes nothing before its first due row regardless.
   *
   * DRIVER KELUAR detection + balance (ported from the legacy
   * fetchExitedFleetOutstanding). A subject is exited when its all-time last
   * transaction date is older than the newest import date ANYWHERE — the
   * reference is the latest upload, so it stays global even under partner
   * scoping (a partner whose whole fleet left still sees every exit). A subject
   * that reappears in a later import stops matching automatically (MAX moves).
   *
   * The balance is the subject's ALL-TIME due − paid (deduction + manual
   * payment, regardless of the counted flag — an exited driver's debt is a "now"
   * fact), skipping bebas-setoran exception days. exitedCount counts only
   * subjects whose balance is non-zero, matching the legacy card. exitedDrivers
   * is the card's click-through detail: one row per exited subject that still
   * carries a balance, sorted by outstanding descending like the legacy modal.
   */
  private async fetchLifecycle(
    mode: MonitoringMode,
    scopePlates?: string[],
  ): Promise<{
    exitedByKey: Map<string, { lastSeen: string; outstanding: number }>;
    firstSeenByKey: Map<string, string>; // key → oldest transaction date ever
    outstandingDriverKeluar: number;
    exitedCount: number;
    exitedDrivers: ExitedDriver[];
    lastImportDate: string | null; // newest transaction date anywhere (modal subtitle)
  }> {
    const empty = {
      exitedByKey: new Map<string, { lastSeen: string; outstanding: number }>(),
      firstSeenByKey: new Map<string, string>(),
      outstandingDriverKeluar: 0,
      exitedCount: 0,
      exitedDrivers: [],
      lastImportDate: null,
    };
    if (scopePlates !== undefined && scopePlates.length === 0) return empty;

    const rowKey = keySql(mode);
    const scopeFilter = scopePlates?.length
      ? sql`AND d.vehicle_plate_norm IN (${sql.join(
          scopePlates.map((p) => sql`${p}`),
          sql`, `,
        )})`
      : sql``;
    // Plate rows: an empty plate is not a subject. Driver rows: the nameless
    // bucket IS a subject (its money must stay visible), so nothing is dropped.
    const subjectFilter = mode === 'driver' ? sql`TRUE` : sql`d.vehicle_plate_norm <> ''`;

    // MIN rides along on a scan that was already unbounded — one extra
    // aggregate over tuples we read anyway, no new query and no new index.
    const lastSeenRows = (await this.database.db.execute(sql`
      SELECT
        ${rowKey} AS key,
        MIN(d.transaction_date)::text AS first_seen,
        MAX(d.transaction_date)::text AS last_seen,
        (SELECT MAX(transaction_date)::text FROM fleet_import_details) AS global_last
      FROM fleet_import_details d
      WHERE ${subjectFilter} ${scopeFilter}
      GROUP BY ${rowKey}
    `)) as unknown as Array<{
      key: string;
      first_seen: string;
      last_seen: string;
      global_last: string;
    }>;

    const lastImportDate = lastSeenRows[0]?.global_last ?? null;
    // Built BEFORE the no-exits early return below — "nothing exited" is the
    // common case, and the join dates must survive it.
    const firstSeenByKey = new Map<string, string>();
    const exitedByKey = new Map<string, { lastSeen: string; outstanding: number }>();
    for (const row of lastSeenRows) {
      firstSeenByKey.set(row.key, row.first_seen);
      if (row.last_seen < row.global_last) {
        exitedByKey.set(row.key, { lastSeen: row.last_seen, outstanding: 0 });
      }
    }
    if (!exitedByKey.size) return { ...empty, firstSeenByKey, lastImportDate };

    const exitedKeys = sql.join(
      [...exitedByKey.keys()].map((k) => sql`${k}`),
      sql`, `,
    );

    const balanceRows = (await this.database.db.execute(sql`
      SELECT
        ${rowKey} AS key,
        SUM(CASE WHEN d.type ILIKE '%due%' THEN ABS(d.amount) ELSE 0 END)::bigint AS target_sum,
        SUM(CASE
            WHEN d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%' THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS paid_sum
      FROM fleet_import_details d
      WHERE (d.type ILIKE '%due%' OR d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%')
        AND ${rowKey} IN (${exitedKeys})
        ${scopeFilter}
        AND NOT EXISTS (
          SELECT 1 FROM fleet_exceptions e
          WHERE e.is_bebas_setoran = TRUE
            AND e.exception_date = d.transaction_date
            AND regexp_replace(upper(e.vehicle_plate), '[^A-Z0-9]', '', 'g') = d.vehicle_plate_norm
        )
      GROUP BY ${rowKey}
    `)) as unknown as Array<{ key: string; target_sum: string; paid_sum: string }>;

    let outstandingDriverKeluar = 0;
    let exitedCount = 0;
    for (const row of balanceRows) {
      const outstanding = Number(row.target_sum) - Number(row.paid_sum);
      exitedByKey.get(row.key)!.outstanding = outstanding;
      outstandingDriverKeluar += outstanding;
      if (outstanding !== 0) exitedCount++;
    }

    // Newest row per exited subject → the driver name / plate it left with
    // (whichever of the two is not the key itself).
    const pairRows = (await this.database.db.execute(sql`
      SELECT DISTINCT ON (${rowKey})
        ${rowKey} AS key,
        d.driver_name,
        d.vehicle_plate_norm AS plate
      FROM fleet_import_details d
      WHERE ${rowKey} IN (${exitedKeys}) ${scopeFilter}
      ORDER BY ${rowKey}, d.transaction_date DESC, d.id DESC
    `)) as unknown as Array<{ key: string; driver_name: string | null; plate: string }>;
    const pairByKey = new Map(pairRows.map((r) => [r.key, r]));

    const exitedDrivers = [...exitedByKey.entries()]
      .filter(([, e]) => e.outstanding !== 0)
      .map(([key, e]) => {
        const pair = pairByKey.get(key);
        return {
          driverName:
            (mode === 'driver' ? key : (pair?.driver_name ?? '')).trim().toUpperCase() ||
            'Unknown Driver',
          plate: mode === 'driver' ? (pair?.plate ?? '') : key,
          lastSeen: e.lastSeen,
          outstanding: e.outstanding,
        };
      })
      .sort((a, b) => b.outstanding - a.outstanding);

    return {
      exitedByKey,
      firstSeenByKey,
      outstandingDriverKeluar,
      exitedCount,
      exitedDrivers,
      lastImportDate,
    };
  }

  /**
   * Cumulative outstanding window (port of the legacy fetchCumulativeStats).
   * Per row subject: Σ|due| (billed) vs Σ|deduction + manual payment| (paid) over
   * ALL history strictly BEFORE the first day of the month AFTER the selected
   * one — no lower bound, so the balance accumulates from the subject's very
   * first imported row, and a past month shows the balance as it stood back then.
   * The month_* columns are the selected month's own slice of the same window,
   * so outstanding(prev month) + outstandingMonth === outstanding by construction.
   * Bebas-setoran days — explicit fleet_exceptions and Rental Monitoring
   * bookings — are excluded from BOTH sides: not billed, not credited.
   *
   * `mode` only swaps the GROUP BY: every exclusion above is per row, so a
   * driver's balance is the exact sum of the plate balances it contributed to.
   * `scopePlates` must still be applied in driver mode — the plate list is what
   * confines a person's balance to this partner's vehicles.
   */
  private async fetchCumulativeStats(
    keys: string[],
    month: number,
    year: number,
    // Tanggal window: adds the month_*_to_day and window_* columns. The row-wise
    // exclusions below apply to the truncated slices for free.
    dayWindow?: DayWindow,
    mode: MonitoringMode = 'plate',
    scopePlates?: string[],
  ): Promise<Map<string, CumulativeStats>> {
    const map = new Map<string, CumulativeStats>();
    if (!keys.length) return map;

    const rowKey = keySql(mode);
    const scopeFilter = scopePlates?.length
      ? sql`AND d.vehicle_plate_norm IN (${sql.join(
          scopePlates.map((p) => sql`${p}`),
          sql`, `,
        )})`
      : sql``;

    const mm = String(month).padStart(2, '0');
    const periodStart = `${year}-${mm}-01`;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const periodEndExclusive = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
    // Both window bounds as business dates: the range's own slice starts at
    // windowStart, while the balance-as-of slice always starts at the 1st.
    const windowStart = dayWindow
      ? `${year}-${mm}-${String(dayWindow.fromDay).padStart(2, '0')}`
      : null;
    const windowEnd = dayWindow
      ? `${year}-${mm}-${String(dayWindow.toDay).padStart(2, '0')}`
      : null;

    const windowColumns =
      windowStart !== null && windowEnd !== null
        ? sql`,
        SUM(CASE
            WHEN d.transaction_date >= ${periodStart}::date
             AND d.transaction_date <= ${windowEnd}::date
             AND d.type ILIKE '%due%' THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS month_target_to_day,
        SUM(CASE
            WHEN d.transaction_date >= ${periodStart}::date
             AND d.transaction_date <= ${windowEnd}::date
             AND (d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%') THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS month_paid_to_day,
        SUM(CASE
            WHEN d.transaction_date >= ${windowStart}::date
             AND d.transaction_date <= ${windowEnd}::date
             AND d.type ILIKE '%due%' THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS window_target,
        SUM(CASE
            WHEN d.transaction_date >= ${windowStart}::date
             AND d.transaction_date <= ${windowEnd}::date
             AND (d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%') THEN ABS(d.amount)
            ELSE 0
        END)::bigint AS window_paid`
        : sql``;

    const result = await this.database.db.execute(sql`
      SELECT
        ${rowKey} AS key,
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
        END)::bigint AS month_paid${windowColumns}
      FROM fleet_import_details d
      WHERE d.transaction_date < ${periodEndExclusive}::date
        AND (d.type ILIKE '%due%' OR d.type ILIKE '%deduction%' OR d.type ILIKE '%manual payment%')
        AND ${rowKey} IN (${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )})
        ${scopeFilter}
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
      GROUP BY ${rowKey}
    `);

    for (const row of result as unknown as Array<Record<string, unknown>>) {
      map.set(String(row.key), {
        cumulativeTarget: Number(row.cum_target),
        cumulativePaid: Number(row.cum_paid),
        monthTarget: Number(row.month_target),
        monthPaid: Number(row.month_paid),
        ...(windowEnd !== null
          ? {
              monthTargetToDay: Number(row.month_target_to_day),
              monthPaidToDay: Number(row.month_paid_to_day),
              windowTarget: Number(row.window_target),
              windowPaid: Number(row.window_paid),
            }
          : {}),
      });
    }
    return map;
  }
}
