/**
 * Rental Monitoring's plate × day pivot — the rental twin of the Gojek and Grab
 * grids. PURE: it takes the very same rows `list()` reads and spreads them with
 * the very same rule (`rentalBookingDays`), so a plate's month total here is the
 * `omset` Rental Management shows, by construction — never a second opinion.
 *
 * What a cell says is *when the car earned*, and the colour says *whether that
 * money has been collected*: Rental has no daily setoran target the way Gojek
 * does, so payment status is the status worth watching.
 */
import { rentals } from '../db/schema';
import { presentRental, rentalBookingDays, type PaymentStatus } from './rental-presenter';

type RentalRow = typeof rentals.$inferSelect;

/** One booking's contribution to the month, for the cell drill-down. */
export interface RentalGridBookingDto {
  id: number;
  customerName: string | null;
  /** Range CLIPPED to the selected month (what the row's cells cover). */
  displayStartDate: string;
  displayEndDate: string;
  days: number;
  omset: number;
  cogsTotal: number;
  nettProfit: number;
  paymentStatus: string;
  rentalType: string | null;
}

export interface RentalGridDayDto {
  /** Integer rupiah this booking contributes to that calendar day. */
  amount: number;
  paymentStatus: string;
  /** Which booking the day belongs to, so a click can open exactly that one. */
  rentalId: number;
}

export interface RentalGridTotalsDto {
  omset: number;
  cogs: number;
  nett: number;
  /** Calendar days of the month the plate was under a booking. */
  rentedDays: number;
}

export interface RentalGridRowDto {
  plateNorm: string;
  plateNumber: string;
  vehicleType: string | null;
  region: string | null;
  /** Sparse: only days covered by a booking appear. */
  days: Record<number, RentalGridDayDto>;
  bookings: RentalGridBookingDto[];
  totals: RentalGridTotalsDto;
}

export interface RentalGridDto {
  month: number;
  year: number;
  daysInMonth: number;
  rows: RentalGridRowDto[];
  /** Σ omset per calendar day over every row — the TOTAL footer. */
  dailyTotals: Record<number, number>;
  totals: RentalGridTotalsDto;
  /** Rows in the table, and how many of them were rented at least one day. */
  plateCount: number;
  activeCount: number;
}

/** A plate the partner registered but that has no booking this month. */
export interface RegisteredPlateInput {
  plateNumber: string;
  plateNumberNorm: string;
  vehicleType: string | null;
}

const UNPAID: PaymentStatus = 'Belum Dibayar';

function emptyTotals(): RentalGridTotalsDto {
  return { omset: 0, cogs: 0, nett: 0, rentedDays: 0 };
}

function emptyRow(plate: RegisteredPlateInput): RentalGridRowDto {
  return {
    plateNorm: plate.plateNumberNorm,
    plateNumber: plate.plateNumber,
    vehicleType: plate.vehicleType,
    region: null,
    days: {},
    bookings: [],
    totals: emptyTotals(),
  };
}

/**
 * Build the pivot for one WIB month.
 *
 * Rows are every plate the partner registered UNION every plate it rented out —
 * a booking may sit on a plate that was never registered (Rental Management
 * accepts that), and an idle registered plate is exactly what a monitoring
 * screen exists to surface. Idle plates therefore appear with an empty row and
 * 0 rented days rather than being dropped.
 *
 * Row order: most omset first, plate as the stable tiebreaker — the same
 * reading order as the other monitoring grids.
 */
export function buildRentalGrid(
  bookings: RentalRow[],
  registered: RegisteredPlateInput[],
  period: { month: number; year: number },
): RentalGridDto {
  const { month, year } = period;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byPlate = new Map<string, RentalGridRowDto & { latestStart: string }>();

  for (const plate of registered) {
    byPlate.set(plate.plateNumberNorm, { ...emptyRow(plate), latestStart: '' });
  }

  for (const booking of bookings) {
    const days = rentalBookingDays(booking, period);
    const dayNumbers = Object.keys(days).map(Number);
    if (!dayNumbers.length) continue; // booking does not overlap the month

    let row = byPlate.get(booking.plateNumberNorm);
    if (!row) {
      row = {
        ...emptyRow({
          plateNumber: booking.plateNumber,
          plateNumberNorm: booking.plateNumberNorm,
          vehicleType: booking.vehicleType,
        }),
        latestStart: '',
      };
      byPlate.set(booking.plateNumberNorm, row);
    }
    // Plate metadata follows the most recent booking, like rentalDailyIncome.
    if (booking.startDate >= row.latestStart) {
      row.latestStart = booking.startDate;
      row.plateNumber = booking.plateNumber;
      row.vehicleType = booking.vehicleType ?? row.vehicleType;
      row.region = booking.region;
    }

    const item = presentRental(booking, { year, month });
    row.bookings.push({
      id: booking.id,
      customerName: booking.customerName,
      displayStartDate: item.displayStartDate,
      displayEndDate: item.displayEndDate,
      days: item.days,
      omset: item.omset,
      cogsTotal: item.cogsTotal,
      nettProfit: item.nettProfit,
      paymentStatus: booking.paymentStatus,
      rentalType: booking.rentalType,
    });
    row.totals.omset += item.omset;
    row.totals.cogs += item.cogsTotal;
    row.totals.nett += item.nettProfit;

    for (const day of dayNumbers) {
      const existing = row.days[day];
      if (!existing) row.totals.rentedDays += 1;
      row.days[day] = {
        amount: (existing?.amount ?? 0) + days[day]!,
        // Overlapping bookings on one plate are blocked on write; if data from
        // before that guard ever surfaces one, the unpaid side wins so the cell
        // never claims money was collected when part of it was not.
        paymentStatus:
          existing?.paymentStatus === UNPAID ? UNPAID : (booking.paymentStatus ?? UNPAID),
        rentalId: existing?.rentalId ?? booking.id,
      };
    }
  }

  const rows = [...byPlate.values()]
    .map(({ latestStart, ...row }) => {
      void latestStart;
      row.bookings.sort((a, b) => a.displayStartDate.localeCompare(b.displayStartDate));
      return row;
    })
    .sort((a, b) => b.totals.omset - a.totals.omset || a.plateNorm.localeCompare(b.plateNorm));

  const dailyTotals: Record<number, number> = {};
  const totals = emptyTotals();
  for (const row of rows) {
    for (const [dayKey, cell] of Object.entries(row.days)) {
      const day = Number(dayKey);
      dailyTotals[day] = (dailyTotals[day] ?? 0) + cell.amount;
    }
    totals.omset += row.totals.omset;
    totals.cogs += row.totals.cogs;
    totals.nett += row.totals.nett;
    totals.rentedDays += row.totals.rentedDays;
  }

  return {
    month,
    year,
    daysInMonth,
    rows,
    dailyTotals,
    totals,
    plateCount: rows.length,
    activeCount: rows.filter((r) => r.totals.rentedDays > 0).length,
  };
}
