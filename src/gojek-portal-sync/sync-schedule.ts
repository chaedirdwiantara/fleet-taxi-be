/**
 * Pure, dependency-free schedule + date-range rules for the Gojek portal sync.
 * All calendar days are WIB (Asia/Jakarta, fixed UTC+7 — no DST).
 */

export const SYNC_TRIGGERS = ['schedule', 'manual'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_STATUSES = ['running', 'success', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const MAX_SCHEDULED_ATTEMPTS_PER_DAY = 3;
export const MIN_LOOKBACK_DAYS = 1;
export const MAX_LOOKBACK_DAYS = 7;
export const MAX_RANGE_DAYS = 31;
export const DEFAULT_RUN_AT = '05:00';

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_AT = /^([01]\d|2[0-3]):(00|30)$/;

export interface WibClock {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time: string;
}

/** WIB wall-clock parts of an instant. */
export function wibClock(now: Date): WibClock {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  return {
    date: `${y}-${m}-${d}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}

/** Run-at is HH:mm on a 30-minute grid. */
export function isValidRunAt(value: string): boolean {
  return RUN_AT.test(value);
}

export function clampLookback(value: number): number {
  if (!Number.isFinite(value)) return MIN_LOOKBACK_DAYS;
  return Math.min(MAX_LOOKBACK_DAYS, Math.max(MIN_LOOKBACK_DAYS, Math.trunc(value)));
}

export interface ScheduleDecision {
  due: boolean;
  reason: string;
}

/**
 * Should the 30-minute tick start a run now? Yes once the clock has passed
 * `runAt`, nothing succeeded or is still running today, and today's attempts
 * are under the cap — so a failure is retried on the next tick, at most
 * MAX_SCHEDULED_ATTEMPTS_PER_DAY times per day.
 */
export function decideSchedule(
  nowHm: string,
  runAtHm: string,
  todayStatuses: readonly string[],
): ScheduleDecision {
  if (nowHm < runAtHm) return { due: false, reason: `Belum jam ${runAtHm} WIB.` };
  if (todayStatuses.includes('success')) return { due: false, reason: 'Sudah berhasil hari ini.' };
  if (todayStatuses.includes('running')) {
    return { due: false, reason: 'Masih ada proses yang berjalan.' };
  }
  if (todayStatuses.length >= MAX_SCHEDULED_ATTEMPTS_PER_DAY) {
    return {
      due: false,
      reason: `Batas ${MAX_SCHEDULED_ATTEMPTS_PER_DAY} percobaan hari ini tercapai.`,
    };
  }
  return {
    due: true,
    reason:
      todayStatuses.length === 0
        ? 'Jadwal harian.'
        : `Percobaan ulang ke-${todayStatuses.length + 1}.`,
  };
}

/** The next tick (HH:00 / HH:30 WIB) at or after `runAt` today, or tomorrow when already past. */
export function nextScheduledAt(now: Date, runAtHm: string, doneToday: boolean): Date {
  const { date, time } = wibClock(now);
  const todayRun = wibDateTimeToUtc(date, runAtHm);
  if (!doneToday && time < runAtHm) return todayRun;
  return new Date(todayRun.getTime() + DAY_MS);
}

export interface DateRange {
  dateFrom: string;
  dateTo: string;
}

/** Default range = yesterday, going back `lookbackDays` days. Today is never pulled. */
export function defaultRange(lookbackDays: number, now: Date): DateRange {
  const yesterday = addDays(wibClock(now).date, -1);
  return { dateFrom: addDays(yesterday, -(clampLookback(lookbackDays) - 1)), dateTo: yesterday };
}

export class InvalidRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRangeError';
  }
}

/** Manual range: both ISO dates, ordered, ≤ MAX_RANGE_DAYS, not beyond today (WIB). */
export function validateRange(dateFrom: string, dateTo: string, now: Date): DateRange {
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    throw new InvalidRangeError('Tanggal rentang tidak valid (format YYYY-MM-DD).');
  }
  if (dateFrom > dateTo) {
    throw new InvalidRangeError('Tanggal awal tidak boleh melewati tanggal akhir.');
  }
  if (dateTo > wibClock(now).date) {
    throw new InvalidRangeError('Tanggal akhir tidak boleh melewati hari ini.');
  }
  if (daysBetween(dateFrom, dateTo) > MAX_RANGE_DAYS) {
    throw new InvalidRangeError(`Rentang maksimal ${MAX_RANGE_DAYS} hari per sinkronisasi.`);
  }
  return { dateFrom, dateTo };
}

/**
 * UTC instants the portal expects for a WIB day range: 00:00:00 WIB of
 * `dateFrom` = 17:00:00.000Z the day before; 23:59:59.999 WIB of `dateTo`
 * = 16:59:59.999Z.
 */
export function utcBounds(range: DateRange): { fromUtc: Date; toUtc: Date } {
  const fromUtc = wibDateTimeToUtc(range.dateFrom, '00:00');
  const toUtc = new Date(wibDateTimeToUtc(range.dateTo, '00:00').getTime() + DAY_MS - 1);
  return { fromUtc, toUtc };
}

export interface PeriodSlice extends DateRange {
  year: number;
  month: number;
}

/**
 * Fleet imports are per (year, month) partition and the grid buckets a row by
 * its day-of-month only, so a range that straddles months must become one
 * import batch per month with the sub-range that falls inside it.
 */
export function splitByMonth(range: DateRange): PeriodSlice[] {
  const slices: PeriodSlice[] = [];
  let cursor = range.dateFrom;
  while (cursor <= range.dateTo) {
    const year = Number(cursor.slice(0, 4));
    const month = Number(cursor.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${cursor.slice(0, 7)}-${pad(lastDay)}`;
    const dateTo = monthEnd < range.dateTo ? monthEnd : range.dateTo;
    slices.push({ year, month, dateFrom: cursor, dateTo });
    cursor = addDays(monthEnd, 1);
  }
  return slices;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive day count. */
export function daysBetween(dateFrom: string, dateTo: string): number {
  return (
    Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / DAY_MS) +
    1
  );
}

function wibDateTimeToUtc(isoDate: string, hm: string): Date {
  return new Date(Date.parse(`${isoDate}T${hm}:00.000Z`) - WIB_OFFSET_MS);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
