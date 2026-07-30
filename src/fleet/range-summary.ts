/**
 * Date-range aggregates for the Gojek dashboard's Tanggal filter.
 *
 * IMPORTANT: nothing here computes money from raw rows. A range is answered by
 * building each calendar month it spans ONCE, with that month's day window, and
 * summing the windowed totals those builds already produced. Every figure below
 * therefore mirrors a whole-month total of the same grid — which is why a range
 * covering exactly one full month reduces to that month's `globalSummary`, and
 * why two adjacent ranges add up to their union.
 */
import {
  daysInRange,
  splitRangeByMonth,
  type DateRange,
  type DayWindow,
} from '../common/util/period';
import { NO_RENTAL_PARTNER, type GojekGridResult } from './gojek-grid.types';

export interface RangeDailyPointDto {
  date: string; // YYYY-MM-DD (Asia/Jakarta calendar day)
  total: number;
}

export interface RangePartnerSliceDto {
  partner: string;
  total: number;
}

/**
 * Aggregates for one date range. `totalDeduction`/`totalDue` are PERIOD figures
 * — what the range itself collected and billed. `outstandingAsOf` is a BALANCE,
 * which only exists relative to a moment: it is the debt as it stood at the end
 * of `toDate`, carried over from the very first import, and `outstandingDelta`
 * is how much of it this range added (positive) or settled (negative).
 */
export interface RangeSummaryDto {
  fromDate: string;
  toDate: string;
  days: number;
  totalDeduction: number;
  totalDue: number;
  outstandingAsOf: number;
  outstandingDelta: number;
  // Charts narrowed to the range: a per-DATE series (day-of-month numbers would
  // collide across a cross-month range) and the range's own partner split.
  charts: {
    daily: RangeDailyPointDto[];
    byPartner: RangePartnerSliceDto[];
  };
}

function businessDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param grids one grid per month the range spans, in chronological order, each
 *   built with that month's `dayWindow` (see splitRangeByMonth).
 */
export function combineGojekRange(grids: GojekGridResult[], range: DateRange): RangeSummaryDto {
  let totalDeduction = 0;
  let totalDue = 0;
  let outstandingDelta = 0;
  // A balance is cumulative, so only the LAST month's as-of figure is the
  // answer — the earlier months are already folded into it.
  let outstandingAsOf = 0;
  const daily: RangeDailyPointDto[] = [];
  const byPartnerMap = new Map<string, number>();

  for (const grid of grids) {
    const window = grid.dayWindow;
    if (!window) continue; // month outside the range (defensive: never happens)

    for (let day = window.fromDay; day <= window.toDay; day++) {
      const total = grid.dailyTotals[day] ?? 0;
      totalDeduction += total;
      daily.push({ date: businessDate(grid.year, grid.month, day), total });
    }
    totalDue += window.totalWindowDue;
    outstandingDelta += window.totalWindowDelta;
    outstandingAsOf = window.totalOutstandingToDay;

    for (const row of grid.rows) {
      let rowTotal = 0;
      for (let day = window.fromDay; day <= window.toDay; day++) {
        rowTotal += row.dailyCountedData[day] ?? 0;
      }
      const partner = row.rentalPartner || NO_RENTAL_PARTNER;
      byPartnerMap.set(partner, (byPartnerMap.get(partner) ?? 0) + rowTotal);
    }
  }

  const byPartner = [...byPartnerMap.entries()]
    .map(([partner, total]) => ({ partner, total }))
    .sort((a, b) => b.total - a.total);

  return {
    fromDate: range.from,
    toDate: range.to,
    days: daysInRange(range),
    totalDeduction,
    totalDue,
    outstandingAsOf,
    outstandingDelta,
    charts: { daily, byPartner },
  };
}

/**
 * Builds everything a summary endpoint needs for one period + optional range,
 * shared by the admin and partner-portal services so both answer identically.
 *
 * The SELECTED month is built exactly once and serves both roles: its
 * whole-month totals are `globalSummary`, and — when the range touches it — its
 * day window is that month's contribution to the range. A range inside the
 * selected month therefore still costs a single grid build.
 *
 * @param buildGrid the caller's scoped grid builder (admin union scope vs one
 *   partner's plate allowlist); everything else here is scope-agnostic.
 */
export async function buildPeriodSummary(
  buildGrid: (month: number, year: number, dayWindow?: DayWindow) => Promise<GojekGridResult>,
  month: number,
  year: number,
  range?: DateRange,
): Promise<{ base: GojekGridResult; range?: RangeSummaryDto }> {
  if (!range) return { base: await buildGrid(month, year) };

  const slices = splitRangeByMonth(range);
  const baseSlice = slices.find((s) => s.year === year && s.month === month);
  const grids = await Promise.all([
    buildGrid(month, year, baseSlice && { fromDay: baseSlice.fromDay, toDay: baseSlice.toDay }),
    ...slices
      .filter((s) => s !== baseSlice)
      .map((s) => buildGrid(s.month, s.year, { fromDay: s.fromDay, toDay: s.toDay })),
  ]);

  const byPeriod = new Map(grids.map((g) => [`${g.year}-${g.month}`, g]));
  // Chronological order matters: the range's closing balance is the last month's.
  const rangeGrids = slices.map((s) => byPeriod.get(`${s.year}-${s.month}`)!);
  return { base: grids[0], range: combineGojekRange(rangeGrids, range) };
}
