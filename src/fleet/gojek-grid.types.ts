export interface BreakdownItem {
  label: string;
  displayAmount: number;
  countedAmount: number;
  isDisplayOnly: boolean;
  note: string;
  // fleet_import_details ids behind this item — populated for manual payments
  // only, so the breakdown modal can deep-link each one to the Edit form
  // (re-toggle Masuk/Tidak Masuk Setoran after processing).
  detailIds: number[];
}

export interface DailyDetailBucket {
  items: BreakdownItem[];
  displayTotal: number;
  countedTotal: number;
  hasDisplayOnlyManualPayment: boolean;
}

export interface ExceptionInfo {
  keterangan: string | null;
  isBebasSetoran: boolean;
}

import type { MonitoringMode } from '../common/util/monitoring-mode';
import type { DueSegment } from './due-segments';

export interface GojekVehicleRow {
  // Row identity: a normalized plate, or `drv:<NORMALIZED NAME>` when the grid
  // was built with `mode: 'driver'`.
  key: string;
  detailId: number | null; // set for synthetic manual_ rows (edit form target)
  driverName: string;
  driverHistory: string[];
  vehicle: string; // normalized plate ('' for unplated manual payments / driver rows)
  // Mirror of driverHistory: the plates this row covers, in order of appearance.
  // Plate mode → the row's own plate; driver mode → every plate the person drove.
  plateHistory: string[];
  rentalPartner: string;
  deliveryBatch: string;
  serviceArea: string;
  vehicleType: string;
  regionId: number | null;
  plateNotFound: boolean;
  targetId: number | null;
  dailyData: Record<number, number>; // display amounts per day
  dailyCountedData: Record<number, number>; // counted amounts per day
  dailyDue: Record<number, number>; // Σ|due| per day — per-day target baseline
  dueSegments: DueSegment[]; // RLE of dailyDue: the Setoran column's ranges
  dailyDetails: Record<number, DailyDetailBucket>;
  manualPaymentDays: number[];
  manualPaymentDisplayOnlyDays: number[];
  exceptions: Record<number, ExceptionInfo>;
  totalDeduction: number; // counted month total
  totalDisplayAmount: number;
  totalDue: number;
  dueCount: number;
  // Representative daily rate for DISPLAY only (Setoran column + cell-tone
  // baseline): the fleet_targets override, else the mode of the observed daily
  // dues, else DEFAULT_DAILY_TARGET. It no longer generates any obligation.
  dailyTarget: number;
  // "Total Due (Target)" — Σ|due| actually imported for the month, with
  // bebas-setoran and Rental Monitoring days waived. Same aggregate that backs
  // `outstanding`, so outstandingMonth === calculatedTarget − paid holds by
  // construction. Days with no due row (not yet elapsed, not yet imported, or
  // the plate had not joined) are not billed.
  calculatedTarget: number;
  // The span calculatedTarget covers, for the UI caption ("21–24 · 4 hari").
  // billedDays === 0 → nothing was billed this month; from/to are then null.
  billedDays: number;
  billFromDay: number | null;
  billToDay: number | null;
  minDay: number;
  // Running balance (Σ due − Σ paid) from the plate's first imported row up to
  // the END of the selected month — a past month shows the balance as it stood
  // then. Negative = credit (overpayment carried forward).
  outstanding: number;
  // The selected month's own delta: outstanding === previous-month outstanding
  // + outstandingMonth by construction.
  outstandingMonth: number;
  // Set only when buildGrid ran with a Tanggal day cutoff: the month's due/paid
  // slices truncated at that day (same window and exclusions as month_*).
  monthTargetToDay?: number;
  monthPaidToDay?: number;
  // Driver keluar: the plate stopped appearing in imports (its all-time last
  // transaction date is older than the newest import date anywhere). Reappearing
  // in a later import automatically clears the flag.
  isExited: boolean;
  exitedLastSeen: string | null; // YYYY-MM-DD of the plate's last import row
  // Plate lifecycle: first transaction date ever imported for this plate, and
  // whether that date falls inside the selected month (a new joiner). Purely a
  // label — a new joiner owes nothing before its first due row either way.
  firstSeen: string | null; // YYYY-MM-DD
  isNewJoiner: boolean;
}

// "Data Mentah Tanpa Plat": a Manual Payment row imported without a vehicle
// plate. It is excluded from the pivot/summary until an admin processes it
// (assigns a plate + Masuk/Tidak Masuk Setoran via edit-driver), after which it
// pivots under its real plate and counts toward the totals.
export interface RawManualRow {
  detailId: number;
  transactionDate: string; // YYYY-MM-DD
  driverName: string;
  amount: number; // ABS, integer rupiah
  isManualPaymentSetoran: number | null;
  note: string | null;
}

// One exited plate with the driver it left with — the Outstanding Driver
// Keluar card's click-through detail (legacy exitedDriversModal rows).
export interface ExitedDriver {
  driverName: string;
  plate: string;
  lastSeen: string; // YYYY-MM-DD of the plate's last import row
  outstanding: number;
}

export interface GojekGridResult {
  month: number;
  year: number;
  daysInMonth: number;
  // Which subject the rows describe. Every total below is mode-independent:
  // both modes sum the same import rows, only the grouping differs.
  mode: MonitoringMode;
  rows: GojekVehicleRow[];
  dailyTotals: Record<number, number>; // counted, over filtered rows
  totalDeduction: number;
  totalCalculatedTarget: number;
  totalOutstanding: number; // active (non-exited) rows only — cumulative ≤ selected month
  totalOutstandingMonth: number; // active rows only — the selected month's delta
  // Unprocessed Manual Payment rows without a plate (admin queue) + their sum.
  // Always empty under partner scoping (an unplated row can't match a scope).
  rawRows: RawManualRow[];
  rawTotalAmount: number;
  // All-time balance of exited plates (due − paid, bebas-setoran days excluded)
  // and how many exited plates still carry a non-zero balance. Partitions the
  // outstanding total with totalOutstanding instead of double-counting it.
  outstandingDriverKeluar: number;
  exitedCount: number;
  exitedDrivers: ExitedDriver[]; // non-zero-balance exited plates, desc by debt
  lastImportDate: string | null; // newest transaction date in the data anywhere
  availableRentalPartners: string[];
  availablePlates: Array<{ plate: string; type: string }>;
  // Present only when buildGrid ran with a valid Tanggal day cutoff: the
  // outstanding totals as they stood at the end of that day (active rows only,
  // same exited-plate partitioning as the whole-month totals above).
  dayCutoff?: {
    day: number;
    totalOutstandingToDay: number;
    totalOutstandingMonthToDay: number;
  };
}

export const NO_RENTAL_PARTNER = '(Tanpa Rental Partner)';
export const DEFAULT_DAILY_TARGET = 488000;
