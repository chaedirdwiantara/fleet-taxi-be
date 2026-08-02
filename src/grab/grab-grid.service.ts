import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { driverRowKey, type MonitoringMode } from '../common/util/monitoring-mode';
import { clampDayWindow, type DayWindow } from '../common/util/period';
import { normalizePlate } from '../common/util/plate';
import { byteCompare } from '../common/util/sort';
import { DatabaseService } from '../db/database.service';
import { normalizeDriverName } from '../partner-drivers/driver.constants';
import { grabImportDetails, grabImports, grabTargets } from '../db/schema';
import { fetchRegisteredPartnerNames } from '../fleet/registered-partner-names';

/** One plate a driver row covers, for the mirror-image history column. */
export interface GrabPlateUse {
  plate: string;
  city: string;
  // Resolved Car Model / Type of THIS plate (grab_target › import › Daftarkan
  // Plat). Per-plate rather than per-row, so a driver row can label each vehicle
  // it drove instead of only the most recent one.
  type: string;
}

export interface GrabVehicleRow {
  // `plate|city|driver` in plate mode, `drv:<NAME>` in driver mode.
  key: string;
  city: string;
  plateNumber: string;
  driverName: string;
  tiering: string;
  vehicleType: string;
  rentalPartner: string;
  // Plates this row covers: its own in plate mode, every plate the person drove
  // in driver mode (mirror of the plate view's single driver name).
  plateHistory: GrabPlateUse[];
  targetId: number | null;
  dailyData: Record<number, number>; // total_earning_collected per day
  totalEarningCollected: number;
  totalIncentive: number;
  totalDriverFare: number;
  totalRides: number;
  details: {
    phone: string | null;
    onlineHours: number;
    bookings: number;
    rides: number;
    cancelByDriver: number;
    fulfillmentRate: number;
    cancellationRate: number;
    fare: number;
    toll: number;
    incentive: number;
    earning: number;
  };
}

/** Label for rows no rental partner claims — the pivot leaves those blank. */
export const NO_RENTAL_PARTNER = 'Tanpa Rental Partner';

export interface GrabGridResult {
  month: number;
  year: number;
  daysInMonth: number;
  // Echo of the clamped Tanggal day window, when one was requested: every money
  // total below then covers ONLY those days. Row identity and the dropdown
  // options stay month-wide, so narrowing the window never hides a vehicle from
  // the filters.
  dayWindow?: DayWindow;
  // Which subject the rows describe; totals are identical in both modes.
  mode: MonitoringMode;
  rows: GrabVehicleRow[];
  totalEarnings: number;
  totalIncentives: number;
  totalDriverFare: number;
  // Filter dropdown options — computed from the FULL pivot BEFORE row filtering,
  // so selecting one partner/city doesn't drop the others (legacy behavior).
  availableRentalPartners: string[];
  availableCities: string[];
  availableVehicleTypes: string[];
}

/** Faithful port of legacy AdminFleetMonitoringGrabController::getIndex. */
@Injectable()
export class GrabGridService {
  constructor(private readonly database: DatabaseService) {}

  /** Newest completed import for the period — the dashboard's "data terakhir" subtitle. */
  async lastImportDate(month: number, year: number): Promise<string | null> {
    const [row] = await this.database.db
      .select({ createdAt: grabImports.createdAt })
      .from(grabImports)
      .where(
        and(
          eq(grabImports.periodMonth, month),
          eq(grabImports.periodYear, year),
          eq(grabImports.status, 'done'),
        ),
      )
      .orderBy(desc(grabImports.createdAt))
      .limit(1);
    return row ? row.createdAt.toISOString() : null;
  }

  async buildGrid(
    month: number,
    year: number,
    filters: {
      rentalPartners?: string[];
      plates?: string[];
      plate?: string;
      // Free-text search over plate AND driver name — one box for both, exactly
      // like the Gojek grid.
      q?: string;
      // "Tipe Kendaraan" filter: a row is kept when ANY of its plates is of a
      // selected type (in driver mode: "drove such a vehicle").
      vehicleTypes?: string[];
      // Server-derived norm → Type map (Daftarkan Plat). Fills the Type of plates
      // the import and grab_targets left blank; see gojek-grid.service.
      vehicleTypeByNorm?: Map<string, string>;
      // Server-derived plate allowlist (partner scoping); see gojek-grid.service.
      scopePlates?: string[];
      // Row subject: one row per plate+city+driver (default) or per driver.
      mode?: MonitoringMode;
      // This month's slice of the dashboard's Tanggal date-range filter. Only
      // the money/ride accumulation is narrowed to it — see GrabGridResult.
      dayWindow?: DayWindow;
    } = {},
  ): Promise<GrabGridResult> {
    const { db } = this.database;
    const mode: MonitoringMode = filters.mode ?? 'plate';
    const byDriver = mode === 'driver';
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dayWindow = clampDayWindow(filters.dayWindow, daysInMonth);
    const inWindow = (day: number): boolean =>
      !dayWindow || (day >= dayWindow.fromDay && day <= dayWindow.toDay);

    if (filters.scopePlates !== undefined && filters.scopePlates.length === 0) {
      return {
        month,
        year,
        daysInMonth,
        ...(dayWindow ? { dayWindow } : {}),
        mode,
        rows: [],
        totalEarnings: 0,
        totalIncentives: 0,
        totalDriverFare: 0,
        availableRentalPartners: [],
        availableCities: [],
        availableVehicleTypes: [],
      };
    }

    const rawRows = await db
      .select()
      .from(grabImportDetails)
      .where(
        and(
          eq(grabImportDetails.periodYear, year),
          eq(grabImportDetails.periodMonth, month),
          filters.scopePlates?.length
            ? inArray(grabImportDetails.plateNumberNorm, filters.scopePlates)
            : undefined,
        ),
      );

    // metaDate: transaction date the metadata columns (plate, city, model,
    // tiering, phone) were taken from, so a driver row shows the vehicle it drove
    // MOST RECENTLY rather than whichever row the scan happened to hit last.
    // Internal working field — stripped before the result is returned.
    const pivot = new Map<string, GrabVehicleRow & { metaDate: string }>();
    // Car Model per plate, kept aside because plateHistory is built one row at a
    // time and the first row of a plate may carry no model while a later one does.
    const carModelByPlate = new Map<string, string>();

    for (const row of rawRows) {
      const day = Number(row.date.slice(8, 10));
      const city = row.city || 'Unknown City';
      const plate = row.plateNumberNorm ?? normalizePlate(row.plateNumber);
      const driver = byDriver
        ? normalizeDriverName(row.driverName ?? '')
        : (row.driverName ?? '').toUpperCase();
      // Driver mode merges the same person across plates and cities; the plate
      // view keeps the legacy composite identity.
      const key = byDriver ? driverRowKey(row.driverName) : `${plate}|${city}|${driver}`;

      let v = pivot.get(key);
      if (!v) {
        v = {
          key,
          city,
          plateNumber: plate,
          driverName: driver,
          tiering: row.tiering || 'REGULAR',
          vehicleType: row.carModel || '-',
          rentalPartner: '',
          plateHistory: [],
          metaDate: row.date,
          targetId: null,
          dailyData: {},
          totalEarningCollected: 0,
          totalIncentive: 0,
          totalDriverFare: 0,
          totalRides: 0,
          details: {
            phone: row.driverPhoneNumber,
            onlineHours: 0,
            bookings: 0,
            rides: 0,
            cancelByDriver: 0,
            fulfillmentRate: 0,
            cancellationRate: 0,
            fare: 0,
            toll: 0,
            incentive: 0,
            earning: 0,
          },
        };
        pivot.set(key, v);
      }

      if (plate && row.carModel) carModelByPlate.set(plate, row.carModel);
      if (plate && !v.plateHistory.some((p) => p.plate === plate && p.city === city)) {
        // `type` is resolved once for all of them below, after grab_targets load.
        v.plateHistory.push({ plate, city, type: '' });
      }
      // A driver row spans vehicles, so its metadata columns show the one driven
      // most recently — the same "latest wins" idea the plate view applies to the
      // driver name, here anchored on the transaction date instead of scan order.
      if (byDriver && row.date >= v.metaDate) {
        v.metaDate = row.date;
        v.plateNumber = plate;
        v.city = city;
        if (row.carModel) v.vehicleType = row.carModel;
        if (row.tiering) v.tiering = row.tiering;
        if (row.driverPhoneNumber) v.details.phone = row.driverPhoneNumber;
      }

      // Outside the Tanggal window the row still exists (identity + dropdown
      // options are month-wide), it just contributes no money.
      if (!inWindow(day)) continue;

      const earning = row.totalEarningCollected ?? 0;
      v.dailyData[day] = (v.dailyData[day] ?? 0) + earning;
      v.totalEarningCollected += earning;
      v.totalIncentive += row.totalIncentive ?? 0;
      v.totalDriverFare += row.driverFare ?? 0;
      v.totalRides += row.totalRides ?? 0;

      v.details.onlineHours += Number(row.totalOnlineHours ?? 0);
      v.details.bookings += row.totalBookings ?? 0;
      v.details.rides += row.totalRides ?? 0;
      v.details.cancelByDriver += row.cancelByDriver ?? 0;
      v.details.fare += row.driverFare ?? 0;
      v.details.toll += row.tollAndOthers ?? 0;
      v.details.incentive += row.totalIncentive ?? 0;
      v.details.earning += earning;
      // legacy: rate fields take the LAST row's value, not a sum
      v.details.fulfillmentRate = Number(row.fullfilmentRate ?? 0);
      v.details.cancellationRate = Number(row.driverCancellationRate ?? 0);
    }

    // target enrichment (exact normalized-plate match, like legacy)
    const [targets, registeredPartnerNames] = await Promise.all([
      db.select().from(grabTargets),
      fetchRegisteredPartnerNames(this.database, [
        ...new Set(
          [...pivot.values()].flatMap((v) => v.plateHistory.map((p) => p.plate)).filter(Boolean),
        ),
      ]),
    ]);
    // norm → Type for every plate the pivot touched, in the same precedence the
    // Car Model column already used: the admin grab_target wins, then the model
    // the import carried, then the Type registered in Daftarkan Plat. One
    // definition read by the Type column, plateHistory and the vehicleTypes
    // filter, so a row can never be filtered by a Type it does not display.
    const plateTypeByNorm = new Map<string, string>();
    for (const [norm, type] of filters.vehicleTypeByNorm ?? []) {
      if (type) plateTypeByNorm.set(norm, type);
    }
    for (const [plate, model] of carModelByPlate) plateTypeByNorm.set(plate, model);
    for (const t of targets) {
      const norm = normalizePlate(t.plateNumber);
      if (norm && t.vehicleType) plateTypeByNorm.set(norm, t.vehicleType);
    }

    for (const v of pivot.values()) {
      const plateClean = v.plateNumber;
      for (const use of v.plateHistory) use.type = plateTypeByNorm.get(use.plate) ?? '';
      for (const t of targets) {
        const tClean = normalizePlate(t.plateNumber);
        if (tClean !== '' && plateClean !== '' && tClean === plateClean) {
          v.targetId = t.id;
          v.rentalPartner = t.rentalPartner ?? '';
          if (t.vehicleType) v.vehicleType = t.vehicleType;
          // A driver row's city is its own history, not a target's attribute.
          if (t.city && !byDriver) v.city = t.city;
          break;
        }
      }
      // A plate registered by a live partner account (Daftarkan Plat) shows that
      // account's name — the target's free-text rental_partner is only a fallback.
      // A driver row takes the label of the last plate it drove (latest-wins).
      if (byDriver) {
        for (const use of v.plateHistory) {
          const name = registeredPartnerNames.get(use.plate);
          if (name) v.rentalPartner = name;
        }
      } else {
        const registeredName = registeredPartnerNames.get(plateClean);
        if (registeredName) v.rentalPartner = registeredName;
      }
      // The import carried no Car Model and no target typed it → show what the
      // partner registered, so the Type column matches Daftarkan Plat.
      if (!v.vehicleType || v.vehicleType === '-') {
        v.vehicleType = plateTypeByNorm.get(plateClean) || v.vehicleType;
      }
    }

    // legacy strcmp order: rental_partner -> city -> plate_number. Driver rows
    // read as a list of people, so the name is the tiebreaker instead of a plate.
    let rows = [...pivot.values()].sort((a, b) =>
      byDriver
        ? byteCompare(a.rentalPartner, b.rentalPartner) || byteCompare(a.driverName, b.driverName)
        : byteCompare(a.rentalPartner, b.rentalPartner) ||
          byteCompare(a.city, b.city) ||
          byteCompare(a.plateNumber, b.plateNumber),
    );

    // dropdown options from the FULL set, before any row filtering
    const availableRentalPartners = [
      ...new Set(rows.map((r) => r.rentalPartner).filter((p) => p !== '')),
    ].sort();
    const availableCities = [
      ...new Set(rows.flatMap((r) => r.plateHistory.map((p) => p.city)).filter((c) => c !== '')),
    ].sort();
    const availableVehicleTypes = [
      ...new Set(rows.flatMap((r) => r.plateHistory.map((p) => p.type)).filter((t) => t !== '')),
    ].sort((a, b) => a.localeCompare(b));

    if (filters.rentalPartners?.length) {
      rows = rows.filter((r) => filters.rentalPartners!.includes(r.rentalPartner));
    }
    // Plate filters match ANY plate of the row — in driver mode that reads as
    // "people who drove this plate".
    if (filters.plates?.length) {
      rows = rows.filter((r) => r.plateHistory.some((p) => filters.plates!.includes(p.plate)));
    }
    const plateQuery = normalizePlate(filters.plate);
    if (plateQuery) {
      rows = rows.filter((r) => r.plateHistory.some((p) => p.plate.includes(plateQuery)));
    }

    // One search box over both identities — see gojek-grid.service.
    const searchPlate = normalizePlate(filters.q);
    const searchName = normalizeDriverName(filters.q ?? '');
    if (searchPlate || searchName) {
      rows = rows.filter(
        (r) =>
          (searchPlate !== '' && r.plateHistory.some((p) => p.plate.includes(searchPlate))) ||
          (searchName !== '' && normalizeDriverName(r.driverName).includes(searchName)),
      );
    }

    const wantedTypes = new Set(
      (filters.vehicleTypes ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t !== ''),
    );
    if (wantedTypes.size) {
      rows = rows.filter((r) =>
        r.plateHistory.some((p) => wantedTypes.has(p.type.trim().toLowerCase())),
      );
    }

    return {
      month,
      year,
      daysInMonth,
      ...(dayWindow ? { dayWindow } : {}),
      mode,
      rows: rows.map((r) => {
        const { metaDate, ...rest } = r;
        void metaDate; // internal working field, not part of the API shape
        return rest;
      }),
      totalEarnings: rows.reduce((s, r) => s + r.totalEarningCollected, 0),
      totalIncentives: rows.reduce((s, r) => s + r.totalIncentive, 0),
      totalDriverFare: rows.reduce((s, r) => s + r.totalDriverFare, 0),
      availableRentalPartners,
      availableCities,
      availableVehicleTypes,
    };
  }

  /** Whole-month row for a row key (drives the "eye" driver-detail modal). The
   * key is `plate|city|driver`, or `drv:<NAME>` when reading per driver. */
  async findRow(
    month: number,
    year: number,
    key: string,
    scopePlates?: string[],
    mode: MonitoringMode = 'plate',
  ): Promise<GrabVehicleRow | null> {
    const grid = await this.buildGrid(month, year, { scopePlates, mode });
    return grid.rows.find((r) => r.key === key) ?? null;
  }

  /**
   * Raw Grab rows behind one cell of the All Fleet matrix: the imported rows for
   * a single day, narrowed to the subject (a plate, or a person across plates).
   * Kept here rather than in the portal service so the earning basis stays in one
   * place — the same `total_earning_collected` the grid sums.
   */
  async dayDetails(
    month: number,
    year: number,
    day: number,
    subject: { plate?: string; driverName?: string },
    scopePlates?: string[],
  ): Promise<
    Array<{
      plateNumber: string;
      driverName: string;
      city: string;
      earning: number;
      rides: number;
      incentive: number;
      driverFare: number;
    }>
  > {
    if (scopePlates !== undefined && scopePlates.length === 0) return [];
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const rows = await this.database.db
      .select()
      .from(grabImportDetails)
      .where(
        and(
          eq(grabImportDetails.periodYear, year),
          eq(grabImportDetails.periodMonth, month),
          eq(grabImportDetails.date, date),
          scopePlates?.length ? inArray(grabImportDetails.plateNumberNorm, scopePlates) : undefined,
          subject.plate ? eq(grabImportDetails.plateNumberNorm, subject.plate) : undefined,
        ),
      );

    return rows
      .filter((r) =>
        subject.driverName === undefined
          ? true
          : normalizeDriverName(r.driverName ?? '') === subject.driverName,
      )
      .map((r) => ({
        plateNumber: r.plateNumberNorm ?? normalizePlate(r.plateNumber),
        driverName: (r.driverName ?? '').toUpperCase(),
        city: r.city || '',
        earning: r.totalEarningCollected ?? 0,
        rides: r.totalRides ?? 0,
        incentive: r.totalIncentive ?? 0,
        driverFare: r.driverFare ?? 0,
      }));
  }
}
