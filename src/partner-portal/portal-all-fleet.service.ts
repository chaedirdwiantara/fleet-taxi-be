import { Injectable } from '@nestjs/common';
import {
  driverLabelFromKey,
  driverRowKey,
  type MonitoringMode,
} from '../common/util/monitoring-mode';
import { gojekActiveDays, gojekDayFacts } from '../fleet/fleet-presenter';
import { GojekGridService } from '../fleet/gojek-grid.service';
import type { GojekVehicleRow } from '../fleet/gojek-grid.types';
import { GrabGridService } from '../grab/grab-grid.service';
import { PartnerRentalsService } from '../partner-rentals/partner-rentals.service';
import {
  buildAllFleetMatrix,
  type AllFleetGojekDay,
  type AllFleetInputRow,
} from './all-fleet-matrix';
import {
  toAllFleetGrid,
  type AllFleetCellDto,
  type AllFleetCellItemDto,
  type AllFleetCellSourceDto,
  type AllFleetGridDto,
} from './all-fleet-presenter';
import { PortalPlatesService } from './portal-plates.service';

/** Row key of the "Tanpa driver" / "Tanpa plat" row (all-fleet-matrix). */
const RESIDUAL_KEY = 'residual';

/**
 * All Fleet Monitoring for the partner portal: the partner's whole fleet income
 * — Gojek setoran + Grab earning + Rental omset — as one subject × day matrix.
 *
 * This service does NOT compute money. It asks each source service for the
 * figures its own screen shows and hands them to the pure matrix builder, so the
 * combined page can never drift from Gojek Monitoring, Grab Monitoring or Rental
 * Monitoring. Scoping: Gojek/Grab by the partner's registered plates (server-side
 * allowlist), Rental by `rentals.partner_id` — exactly like the source screens,
 * which is why a rental on an unregistered plate still shows up here just as it
 * does on Rental Monitoring.
 */
@Injectable()
export class PortalAllFleetService {
  constructor(
    private readonly plates: PortalPlatesService,
    private readonly gojek: GojekGridService,
    private readonly grab: GrabGridService,
    private readonly rentals: PartnerRentalsService,
  ) {}

  async grid(
    partnerId: number,
    month: number,
    year: number,
    mode: MonitoringMode,
  ): Promise<AllFleetGridDto> {
    const byDriver = mode === 'driver';
    const [scopePlates, typeByNorm] = await Promise.all([
      this.plates.registeredNorms(partnerId),
      this.plates.typeByNorm(partnerId),
    ]);

    const [gojekGrid, grabGrid, rental] = await Promise.all([
      this.gojek.buildGrid(month, year, { scopePlates, mode }),
      this.grab.buildGrid(month, year, { scopePlates, mode }),
      this.rentals.dailyIncome(partnerId, month, year),
    ]);

    const gojek: AllFleetInputRow[] = gojekGrid.rows.map((row) => {
      const { days, zeroDays } = splitDays(row.dailyCountedData);
      return {
        // Plate mode: the grid's row key already IS the normalized plate.
        key: byDriver ? row.key : row.vehicle,
        label: byDriver ? row.driverName : row.vehicle,
        sublabel: byDriver ? null : row.vehicleType || typeByNorm.get(row.vehicle) || null,
        days,
        zeroDays,
        gojekDays: gojekDayStatuses(row),
        history: byDriver
          ? row.plateHistory.map((plate) => ({ label: plate }))
          : row.driverHistory.map((driver) => ({ label: driver })),
      };
    });

    const grab: AllFleetInputRow[] = grabGrid.rows.map((row) => {
      const { days, zeroDays } = splitDays(row.dailyData);
      return {
        // Plate mode: several composite rows (city / driver) share one plate and
        // merge in the matrix.
        key: byDriver ? row.key : row.plateNumber,
        label: byDriver ? row.driverName : row.plateNumber,
        sublabel: byDriver
          ? null
          : normalizeGrabType(row.vehicleType) || typeByNorm.get(row.plateNumber) || null,
        days,
        zeroDays,
        history: byDriver
          ? row.plateHistory.map((use) => ({ label: use.plate, sublabel: use.city || null }))
          : [{ label: row.driverName, sublabel: row.city || null }],
      };
    });

    const matrix = buildAllFleetMatrix({
      mode,
      daysInMonth: gojekGrid.daysInMonth,
      gojek,
      grab,
      rental,
    });

    return toAllFleetGrid(matrix, {
      month,
      year,
      daysInMonth: gojekGrid.daysInMonth,
      mode,
    });
  }

  /**
   * The transactions behind one cell: Gojek's setoran breakdown, Grab's imported
   * rows and the rental bookings covering that day. Returns null when the cell
   * turns out to be empty, so the controller can answer 404 instead of an
   * all-zero modal.
   */
  async cell(
    partnerId: number,
    month: number,
    year: number,
    key: string,
    day: number,
    mode: MonitoringMode,
  ): Promise<AllFleetCellDto | null> {
    const byDriver = mode === 'driver';
    const isResidual = key === RESIDUAL_KEY;
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // Which subject the cell belongs to. The residual row is the nameless /
    // plateless bucket, so it resolves to the empty identity — which is exactly
    // how the sources store those rows.
    const driverName = byDriver ? (isResidual ? '' : driverLabelFromKey(key)) : undefined;
    const plate = byDriver ? undefined : isResidual ? '' : key;
    const gojekRowKey = byDriver ? driverRowKey(driverName ?? '') : (plate ?? '');

    const [gojekBucket, grabRows, rentalBookings] = await Promise.all([
      gojekRowKey === ''
        ? Promise.resolve(null)
        : this.gojek.getCell(month, year, gojekRowKey, day, scopePlates, mode),
      this.grab.dayDetails(month, year, day, { plate, driverName }, scopePlates),
      // A driver row has no rental income (Rental Monitoring records no driver),
      // so rental bookings only appear for plate rows and for "Tanpa driver".
      byDriver && !isResidual
        ? Promise.resolve([])
        : this.rentals.dayBookings(partnerId, month, year, day, plate || undefined),
    ]);

    const sources: AllFleetCellSourceDto[] = [];

    if (gojekBucket && gojekBucket.items.length > 0) {
      sources.push({
        source: 'gojek',
        // The counted total is what the matrix summed — display-only manual
        // payments are listed with their note but add nothing.
        total: gojekBucket.countedTotal,
        items: gojekBucket.items.map((item) => ({
          label: item.label,
          sublabel: null,
          amount: item.countedAmount,
          note:
            item.note ||
            (item.isDisplayOnly
              ? `Tidak masuk setoran — ditampilkan ${formatItemAmount(item.displayAmount)}`
              : null),
        })),
      });
    }

    if (grabRows.length > 0) {
      sources.push({
        source: 'grab',
        total: grabRows.reduce((sum, r) => sum + r.earning, 0),
        items: grabRows.map((r) => ({
          label: r.driverName || 'Tanpa nama driver',
          sublabel: [r.plateNumber, r.city].filter(Boolean).join(' · ') || null,
          amount: r.earning,
          note: `${r.rides} trip · insentif ${formatItemAmount(r.incentive)}`,
        })),
      });
    }

    if (rentalBookings.length > 0) {
      sources.push({
        source: 'rental',
        total: rentalBookings.reduce((sum, r) => sum + r.amountForDay, 0),
        items: rentalBookings.map((r) => ({
          label: r.customerName || 'Tanpa nama penyewa',
          sublabel: [r.plateNumber, `${r.displayStartDate} → ${r.displayEndDate}`]
            .filter(Boolean)
            .join(' · '),
          amount: r.amountForDay,
          note: r.paymentStatus,
        })),
      });
    }

    if (!sources.length) return null;

    return {
      key,
      label: isResidual
        ? byDriver
          ? 'Tanpa driver'
          : 'Tanpa plat'
        : byDriver
          ? driverName || 'Tanpa nama driver'
          : key,
      date,
      total: sources.reduce((sum, s) => sum + s.total, 0),
      sources,
    };
  }
}

/**
 * Gojek's per-day verdict for one row, keyed by day-of-month — the same facts
 * `fleet-presenter` hands the Gojek grid, plus that day's target baseline, so
 * All Fleet can colour its figures with the identical legend. Money is NOT
 * taken from here; it still comes from `dailyCountedData` above.
 */
function gojekDayStatuses(row: GojekVehicleRow): Record<number, AllFleetGojekDay> {
  const statuses: Record<number, AllFleetGojekDay> = {};
  for (const day of gojekActiveDays(row)) {
    statuses[day] = {
      ...gojekDayFacts(row, day),
      dailyTarget: row.dailyDue[day] ?? row.dailyTarget,
    };
  }
  return statuses;
}

/**
 * Split a source's per-day map into "earned something" and "present but Rp 0".
 * The zero days are what make the pink cell possible — the sources record a day
 * with a Rp 0 counted amount when a transaction exists but nothing was collected.
 */
function splitDays(perDay: Record<number, number>): {
  days: Record<number, number>;
  zeroDays: number[];
} {
  const days: Record<number, number> = {};
  const zeroDays: number[] = [];
  for (const [dayKey, amount] of Object.entries(perDay)) {
    if (amount === 0) zeroDays.push(Number(dayKey));
    else days[Number(dayKey)] = amount;
  }
  return { days, zeroDays };
}

/** The Grab importer writes '-' when the car model is missing. */
function normalizeGrabType(vehicleType: string): string {
  return vehicleType === '-' ? '' : vehicleType;
}

/** Note-only formatting; the amounts themselves stay integer rupiah on the wire. */
function formatItemAmount(amount: number): string {
  return `Rp ${amount.toLocaleString('id-ID')}`;
}

// Type re-export so controllers can name the payload without reaching into the
// presenter module.
export type { AllFleetCellItemDto };
