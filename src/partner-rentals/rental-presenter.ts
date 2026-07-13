/**
 * Presentation + pure computation layer for Rental Monitoring (port of the
 * legacy admin/jadwal-mobil-cogs page). Everything money-related is computed
 * HERE, backend-side, in integer rupiah — the client only formats. All
 * functions are pure so the month-clipping/aggregation math is unit-testable
 * without a database.
 */
import { rentals } from '../db/schema';

type RentalRow = typeof rentals.$inferSelect;

export const PAYMENT_STATUSES = ['Belum Dibayar', 'Sudah Dibayar'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const RENTAL_TYPES = ['Dengan Driver', 'Lepas Kunci'] as const;
export const PRICE_UNITS = ['hari', 'bulan'] as const;

export const SORT_FIELDS = ['date', 'duration', 'status', 'omset', 'cogs'] as const;
export type RentalSortField = (typeof SORT_FIELDS)[number];
export type SortOrder = 'asc' | 'desc';

// ---- API DTOs ---------------------------------------------------------------

export interface RentalItemDto {
  id: number;
  plateNumber: string;
  vehicleType: string | null;
  region: string | null;
  /** Full stored range (for edit forms) — NOT clipped to the month. */
  startDate: string;
  endDate: string;
  /** Range clipped to the selected month (equals start/end when unclipped). */
  displayStartDate: string;
  displayEndDate: string;
  /** Inclusive day count of the CLIPPED range. */
  days: number;
  pricePerDay: number;
  cogsPerDay: number;
  cogsType: string | null;
  additionalCost: number;
  additionalCostDescription: string | null;
  deposit: number;
  rentalType: string | null;
  infoSource: string | null;
  serviceArea: string | null;
  customerName: string | null;
  customerPhone: string | null;
  paymentStatus: string;
  gross: number;
  cogsTotal: number;
  nettProfit: number;
  omset: number;
  createdAt: string;
  updatedAt: string;
}

export interface RentalSummaryDto {
  totalTransactions: number;
  unpaidTransactions: number;
  unpaidGross: number;
  paidGross: number;
  paidCogs: number;
  paidAdditionalCost: number;
  paidNettProfit: number;
}

export interface NettByTypeDto {
  cogsType: string;
  gross: number;
  cogs: number;
  nett: number;
  count: number;
}

// ---- date helpers (calendar-date math on 'YYYY-MM-DD' strings, TZ-free) -----

const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toUtcMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d);
}

/** Inclusive day count between two 'YYYY-MM-DD' dates (01 → 27 = 27 days). */
export function daysInclusive(startDate: string, endDate: string): number {
  return Math.round((toUtcMs(endDate) - toUtcMs(startDate)) / DAY_MS) + 1;
}

/** First/last calendar day of (year, month) as 'YYYY-MM-DD'. */
export function monthBounds(year: number, month: number): { start: string; end: string } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/** Current (month, year) in the business timezone Asia/Jakarta (WIB). */
export function currentPeriodWib(now = new Date()): { month: number; year: number } {
  // en-CA yields YYYY-MM-DD, so the WIB local date is directly parseable.
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
    .format(now)
    .split('-');
  return { month: Number(m), year: Number(y) };
}

// ---- item presentation -------------------------------------------------------

/**
 * Map a rentals row → RentalItemDto, optionally clipped to a month.
 *
 * Legacy month semantics: a rental appears in month M when [startDate, endDate]
 * overlaps M; its displayed range and day count are CLIPPED to M, so
 *   gross     = pricePerDay × clippedDays
 *   cogsTotal = cogsPerDay × clippedDays
 *   nettProfit = gross − cogsTotal − additionalCost
 *   omset     = gross + additionalCost
 * additionalCost is a per-TRANSACTION total: it is counted in full, once, in
 * ANY month the rental appears in (a cross-month rental therefore carries its
 * whole additionalCost into every overlapped month — faithful legacy behavior).
 */
export function presentRental(
  row: RentalRow,
  clipTo?: { year: number; month: number },
): RentalItemDto {
  let displayStartDate = row.startDate;
  let displayEndDate = row.endDate;
  if (clipTo) {
    const { start, end } = monthBounds(clipTo.year, clipTo.month);
    if (displayStartDate < start) displayStartDate = start;
    if (displayEndDate > end) displayEndDate = end;
  }
  const days = daysInclusive(displayStartDate, displayEndDate);
  const gross = row.pricePerDay * days;
  const cogsTotal = row.cogsPerDay * days;
  return {
    id: row.id,
    plateNumber: row.plateNumber,
    vehicleType: row.vehicleType,
    region: row.region,
    startDate: row.startDate,
    endDate: row.endDate,
    displayStartDate,
    displayEndDate,
    days,
    pricePerDay: row.pricePerDay,
    cogsPerDay: row.cogsPerDay,
    cogsType: row.cogsType,
    additionalCost: row.additionalCost,
    additionalCostDescription: row.additionalCostDescription,
    deposit: row.deposit,
    rentalType: row.rentalType,
    infoSource: row.infoSource,
    serviceArea: row.serviceArea,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    paymentStatus: row.paymentStatus,
    gross,
    cogsTotal,
    nettProfit: gross - cogsTotal - row.additionalCost,
    omset: gross + row.additionalCost,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- filtering / sorting / aggregation ---------------------------------------

/** Case-insensitive substring match on plateNumber OR customerName OR serviceArea. */
export function matchesSearch(item: RentalItemDto, search: string): boolean {
  const q = search.toLowerCase();
  return [item.plateNumber, item.customerName, item.serviceArea].some(
    (v) => v != null && v.toLowerCase().includes(q),
  );
}

export function sortRentalItems(
  items: RentalItemDto[],
  sortBy: RentalSortField,
  sortOrder: SortOrder,
): RentalItemDto[] {
  const dir = sortOrder === 'desc' ? -1 : 1;
  const key = (i: RentalItemDto): string | number => {
    switch (sortBy) {
      case 'duration':
        return i.days;
      case 'status':
        return i.paymentStatus;
      case 'omset':
        return i.omset;
      case 'cogs':
        return i.cogsTotal;
      case 'date':
      default:
        return i.displayStartDate;
    }
  };
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -dir;
    if (ka > kb) return dir;
    return 0;
  });
}

export function summarizeRentals(items: RentalItemDto[]): RentalSummaryDto {
  const unpaid = items.filter((i) => i.paymentStatus === 'Belum Dibayar');
  const paid = items.filter((i) => i.paymentStatus === 'Sudah Dibayar');
  const sum = (xs: RentalItemDto[], f: (i: RentalItemDto) => number): number =>
    xs.reduce((acc, i) => acc + f(i), 0);
  const paidGross = sum(paid, (i) => i.gross);
  const paidCogs = sum(paid, (i) => i.cogsTotal);
  const paidAdditionalCost = sum(paid, (i) => i.additionalCost);
  return {
    totalTransactions: items.length,
    unpaidTransactions: unpaid.length,
    unpaidGross: sum(unpaid, (i) => i.gross),
    paidGross,
    paidCogs,
    paidAdditionalCost,
    paidNettProfit: paidGross - paidCogs - paidAdditionalCost,
  };
}

/** Paid-only nett recap per cogsType (fallback 'Lainnya'), sorted by nett desc. */
export function nettByType(items: RentalItemDto[]): NettByTypeDto[] {
  const byType = new Map<string, NettByTypeDto>();
  for (const i of items) {
    if (i.paymentStatus !== 'Sudah Dibayar') continue;
    const type = i.cogsType?.trim() || 'Lainnya';
    const entry = byType.get(type) ?? { cogsType: type, gross: 0, cogs: 0, nett: 0, count: 0 };
    entry.gross += i.gross;
    entry.cogs += i.cogsTotal;
    entry.nett += i.nettProfit;
    entry.count += 1;
    byType.set(type, entry);
  }
  return [...byType.values()].sort((a, b) => b.nett - a.nett);
}

// ---- cogs-defaults helpers ----------------------------------------------------

/** Slugify a vehicle-type label into a key: lowercase, non-alphanumeric → '_'. */
export function slugifyCogsKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
