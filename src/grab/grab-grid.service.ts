import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { byteCompare } from '../common/util/sort';
import { DatabaseService } from '../db/database.service';
import { grabImportDetails, grabImports, grabTargets } from '../db/schema';
import { fetchRegisteredPartnerNames } from '../fleet/registered-partner-names';

export interface GrabVehicleRow {
  key: string; // plate|city|driver
  city: string;
  plateNumber: string;
  driverName: string;
  tiering: string;
  vehicleType: string;
  rentalPartner: string;
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

export interface GrabGridResult {
  month: number;
  year: number;
  daysInMonth: number;
  rows: GrabVehicleRow[];
  totalEarnings: number;
  totalIncentives: number;
  totalDriverFare: number;
  // Filter dropdown options — computed from the FULL pivot BEFORE row filtering,
  // so selecting one partner/city doesn't drop the others (legacy behavior).
  availableRentalPartners: string[];
  availableCities: string[];
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
      // Server-derived plate allowlist (partner scoping); see gojek-grid.service.
      scopePlates?: string[];
    } = {},
  ): Promise<GrabGridResult> {
    const { db } = this.database;

    if (filters.scopePlates !== undefined && filters.scopePlates.length === 0) {
      return {
        month,
        year,
        daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
        rows: [],
        totalEarnings: 0,
        totalIncentives: 0,
        totalDriverFare: 0,
        availableRentalPartners: [],
        availableCities: [],
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

    const pivot = new Map<string, GrabVehicleRow>();

    for (const row of rawRows) {
      const day = Number(row.date.slice(8, 10));
      const city = row.city || 'Unknown City';
      const plate = row.plateNumberNorm ?? normalizePlate(row.plateNumber);
      const driver = (row.driverName ?? '').toUpperCase();
      const key = `${plate}|${city}|${driver}`;

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
        ...new Set([...pivot.values()].map((v) => v.plateNumber).filter((p) => p !== '')),
      ]),
    ]);
    for (const v of pivot.values()) {
      const plateClean = v.plateNumber;
      for (const t of targets) {
        const tClean = normalizePlate(t.plateNumber);
        if (tClean !== '' && plateClean !== '' && tClean === plateClean) {
          v.rentalPartner = t.rentalPartner ?? '';
          v.targetId = t.id;
          if (t.vehicleType) v.vehicleType = t.vehicleType;
          if (t.city) v.city = t.city;
          break;
        }
      }
      // A plate registered by a live partner account (Daftarkan Plat) shows that
      // account's name — the target's free-text rental_partner is only a fallback.
      const registeredName = registeredPartnerNames.get(plateClean);
      if (registeredName) v.rentalPartner = registeredName;
    }

    // legacy strcmp order: rental_partner -> city -> plate_number
    let rows = [...pivot.values()].sort(
      (a, b) =>
        byteCompare(a.rentalPartner, b.rentalPartner) ||
        byteCompare(a.city, b.city) ||
        byteCompare(a.plateNumber, b.plateNumber),
    );

    // dropdown options from the FULL set, before any row filtering
    const availableRentalPartners = [
      ...new Set(rows.map((r) => r.rentalPartner).filter((p) => p !== '')),
    ].sort();
    const availableCities = [...new Set(rows.map((r) => r.city).filter((c) => c !== ''))].sort();

    if (filters.rentalPartners?.length) {
      rows = rows.filter((r) => filters.rentalPartners!.includes(r.rentalPartner));
    }
    if (filters.plates?.length) {
      rows = rows.filter((r) => filters.plates!.includes(r.plateNumber));
    }
    const plateQuery = normalizePlate(filters.plate);
    if (plateQuery) {
      rows = rows.filter((r) => r.plateNumber.includes(plateQuery));
    }

    return {
      month,
      year,
      daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
      rows,
      totalEarnings: rows.reduce((s, r) => s + r.totalEarningCollected, 0),
      totalIncentives: rows.reduce((s, r) => s + r.totalIncentive, 0),
      totalDriverFare: rows.reduce((s, r) => s + r.totalDriverFare, 0),
      availableRentalPartners,
      availableCities,
    };
  }

  /** Whole-month row for the composite key (drives the "eye" driver-detail modal). */
  async findRow(
    month: number,
    year: number,
    key: string,
    scopePlates?: string[],
  ): Promise<GrabVehicleRow | null> {
    const grid = await this.buildGrid(month, year, { scopePlates });
    return grid.rows.find((r) => r.key === key) ?? null;
  }
}
