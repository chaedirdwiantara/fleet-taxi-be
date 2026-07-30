import { BadRequestException } from '@nestjs/common';

/** Parses ?month&year query params (both required, month 1..12). */
export function parsePeriod(monthRaw: unknown, yearRaw: unknown): { month: number; year: number } {
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestException('month must be an integer 1..12');
  }
  if (!Number.isInteger(year) || year < 2020 || year > 2099) {
    throw new BadRequestException('year must be an integer 2020..2099');
  }
  return { month, year };
}

export function toStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x as string | number));
  if (typeof v === 'string' && v !== '') return [v];
  if (typeof v === 'number') return [String(v)];
  return undefined;
}

// ── date range (?dateFrom&dateTo) ────────────────────────────────────────────

/** Inclusive span of Asia/Jakarta calendar days, `YYYY-MM-DD` on both ends. */
export interface DateRange {
  from: string;
  to: string;
}

/**
 * A day span WITHIN one calendar month (1-based day-of-month, both inclusive) —
 * how a monthly grid build receives its share of a (possibly cross-month) range.
 */
export interface DayWindow {
  fromDay: number;
  toDay: number;
}

/** One calendar month's slice of a DateRange. */
export interface MonthSlice extends DayWindow {
  year: number;
  month: number;
}

/**
 * Longest span the dashboard's date-range filter accepts. The range aggregates
 * run one monthly grid build per calendar month they span, so this caps that
 * fan-out at three builds — generous for the "dari tanggal berapa ke berapa"
 * question the filter answers, and bounded enough to keep the request snappy.
 */
export const MAX_RANGE_DAYS = 92;

/** Shared Swagger blurb for the ?dateFrom&dateTo pair. */
export const DATE_RANGE_DOC =
  `Inclusive date range for the summary aggregates (YYYY-MM-DD). Send with dateTo or not at all; ` +
  `may span months; max ${MAX_RANGE_DAYS} days. Omitted = whole selected month.`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** UTC epoch of a `YYYY-MM-DD` business date — for day arithmetic only. */
function epochOf(isoDate: string): number {
  return Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
}

/** Validates a `YYYY-MM-DD` param and rejects impossible dates (2026-02-30). */
function parseISODateParam(raw: string, name: string): string {
  if (!ISO_DATE.test(raw)) {
    throw new BadRequestException(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  const day = Number(raw.slice(8, 10));
  const date = new Date(epochOf(raw));
  if (date.getUTCDate() !== day) {
    throw new BadRequestException(`${name} is not a valid calendar date`);
  }
  return raw;
}

/** Number of days a range covers, both ends inclusive. */
export function daysInRange(range: DateRange): number {
  return Math.round((epochOf(range.to) - epochOf(range.from)) / MS_PER_DAY) + 1;
}

/**
 * Parses the optional ?dateFrom&dateTo pair. Absent (both) → `undefined`, i.e.
 * whole-period semantics. The two must travel together: a half-specified range
 * is a client bug, and silently widening it to a month boundary would show
 * numbers nobody asked for.
 */
export function parseDateRange(dateFromRaw: unknown, dateToRaw: unknown): DateRange | undefined {
  const rawFrom = typeof dateFromRaw === 'string' && dateFromRaw !== '' ? dateFromRaw : undefined;
  const rawTo = typeof dateToRaw === 'string' && dateToRaw !== '' ? dateToRaw : undefined;
  if (rawFrom === undefined && rawTo === undefined) return undefined;
  if (rawFrom === undefined || rawTo === undefined) {
    throw new BadRequestException('dateFrom and dateTo must be sent together');
  }

  const from = parseISODateParam(rawFrom, 'dateFrom');
  const to = parseISODateParam(rawTo, 'dateTo');
  // ISO dates sort lexicographically, so a string compare IS the date compare.
  if (from > to) throw new BadRequestException('dateFrom must not be after dateTo');
  const days = daysInRange({ from, to });
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(`date range must not exceed ${MAX_RANGE_DAYS} days`);
  }
  return { from, to };
}

/**
 * Confines a requested window to days the given month actually has. A window
 * that misses the month entirely is dropped rather than clamped onto its edge —
 * the caller asked about days that do not exist there, and an edge day would be
 * an answer to a different question.
 */
export function clampDayWindow(
  window: DayWindow | undefined,
  daysInMonth: number,
): DayWindow | undefined {
  if (!window) return undefined;
  const { fromDay, toDay } = window;
  if (!Number.isInteger(fromDay) || !Number.isInteger(toDay)) return undefined;
  if (fromDay > toDay || fromDay > daysInMonth || toDay < 1) return undefined;
  return { fromDay: Math.max(fromDay, 1), toDay: Math.min(toDay, daysInMonth) };
}

/**
 * Cuts a range into per-calendar-month slices, in chronological order. The
 * import data is partitioned by (period_year, period_month) and every grid
 * aggregate is monthly, so a cross-month range is answered by building each
 * month once with its own day window and summing the pieces.
 */
export function splitRangeByMonth(range: DateRange): MonthSlice[] {
  const endYear = Number(range.to.slice(0, 4));
  const endMonth = Number(range.to.slice(5, 7));
  const endDay = Number(range.to.slice(8, 10));

  const slices: MonthSlice[] = [];
  let year = Number(range.from.slice(0, 4));
  let month = Number(range.from.slice(5, 7));
  let fromDay = Number(range.from.slice(8, 10));

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const isLast = year === endYear && month === endMonth;
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    slices.push({ year, month, fromDay, toDay: isLast ? endDay : lastDayOfMonth });
    fromDay = 1;
    if (month === 12) {
      month = 1;
      year += 1;
    } else {
      month += 1;
    }
  }
  return slices;
}
