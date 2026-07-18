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

import type { DueSegment } from './due-segments';

export interface GojekVehicleRow {
  key: string; // normalized plate or manual_<detailId>
  detailId: number | null; // set for synthetic manual_ rows (edit form target)
  driverName: string;
  driverHistory: string[];
  vehicle: string; // normalized plate ('' for unplated manual payments)
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
  dailyTarget: number;
  calculatedTarget: number;
  activeDays: number;
  minDay: number;
  // Running balance (Σ due − Σ paid) from the plate's first imported row up to
  // the END of the selected month — a past month shows the balance as it stood
  // then. Negative = credit (overpayment carried forward).
  outstanding: number;
  // The selected month's own delta: outstanding === previous-month outstanding
  // + outstandingMonth by construction.
  outstandingMonth: number;
  // Driver keluar: the plate stopped appearing in imports (its all-time last
  // transaction date is older than the newest import date anywhere). Reappearing
  // in a later import automatically clears the flag.
  isExited: boolean;
  exitedLastSeen: string | null; // YYYY-MM-DD of the plate's last import row
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

export interface GojekPerformer {
  driverName: string;
  vehicle: string; // comma-joined plates
  totalDeduction: number;
  outstanding: number;
}

export interface GojekGridResult {
  month: number;
  year: number;
  daysInMonth: number;
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
  availableRentalPartners: string[];
  availablePlates: Array<{ plate: string; type: string }>;
  topPerformers: GojekPerformer[];
  bottomPerformers: GojekPerformer[];
}

export const NO_RENTAL_PARTNER = '(Tanpa Rental Partner)';
export const DEFAULT_DAILY_TARGET = 488000;
