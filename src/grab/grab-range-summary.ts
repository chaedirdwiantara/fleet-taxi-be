/**
 * Date-range aggregates for the Grab dashboard's Tanggal filter — the Grab twin
 * of fleet/range-summary.ts, and built the same way: each calendar month the
 * range spans is pivoted ONCE with its own day window, and the windowed totals
 * those builds produced are summed here. No money is re-derived from raw rows,
 * so a range covering one full month reduces to that month's whole-month totals.
 */
import {
  daysInRange,
  splitRangeByMonth,
  type DateRange,
  type DayWindow,
} from '../common/util/period';
import { NO_RENTAL_PARTNER, type GrabGridResult } from './grab-grid.service';

export interface GrabRangeSummaryDto {
  fromDate: string;
  toDate: string;
  days: number;
  totalEarning: number;
  totalDriverFare: number;
  totalIncentive: number;
  totalRides: number;
  // Vehicles that actually earned inside the range — a month-wide row with no
  // in-range activity is not "active" for the period the user asked about.
  activeVehicles: number;
  charts: {
    daily: { date: string; total: number }[];
    byPartner: { partner: string; total: number }[];
  };
}

function businessDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * @param grids one grid per month the range spans, in chronological order, each
 *   built with that month's `dayWindow`.
 */
export function combineGrabRange(grids: GrabGridResult[], range: DateRange): GrabRangeSummaryDto {
  let totalEarning = 0;
  let totalDriverFare = 0;
  let totalIncentive = 0;
  let totalRides = 0;
  const daily: { date: string; total: number }[] = [];
  const byPartnerMap = new Map<string, number>();
  // A vehicle driven across the month boundary is still one vehicle.
  const activeKeys = new Set<string>();

  for (const grid of grids) {
    const window = grid.dayWindow;
    if (!window) continue; // month outside the range (defensive: never happens)

    totalEarning += grid.totalEarnings;
    totalDriverFare += grid.totalDriverFare;
    totalIncentive += grid.totalIncentives;

    const dailyTotals: Record<number, number> = {};
    for (const row of grid.rows) {
      totalRides += row.totalRides;
      const partner = row.rentalPartner || NO_RENTAL_PARTNER;
      byPartnerMap.set(partner, (byPartnerMap.get(partner) ?? 0) + row.totalEarningCollected);
      let earnedInWindow = false;
      for (const [day, earning] of Object.entries(row.dailyData)) {
        dailyTotals[Number(day)] = (dailyTotals[Number(day)] ?? 0) + earning;
        earnedInWindow = true;
      }
      if (earnedInWindow) activeKeys.add(row.key);
    }

    for (let day = window.fromDay; day <= window.toDay; day++) {
      daily.push({ date: businessDate(grid.year, grid.month, day), total: dailyTotals[day] ?? 0 });
    }
  }

  const byPartner = [...byPartnerMap.entries()]
    .map(([partner, total]) => ({ partner, total }))
    .sort((a, b) => b.total - a.total);

  return {
    fromDate: range.from,
    toDate: range.to,
    days: daysInRange(range),
    totalEarning,
    totalDriverFare,
    totalIncentive,
    totalRides,
    activeVehicles: activeKeys.size,
    charts: { daily, byPartner },
  };
}

/**
 * Grab twin of fleet's buildPeriodSummary.
 *
 * Unlike the Gojek grid — where a day window only ADDS columns — a windowed Grab
 * pivot narrows its own totals, so the selected month cannot serve both roles at
 * once: it is built unwindowed for `globalSummary`, and each month of the range
 * is built again with its window. That is one extra pivot over a single month's
 * rows, which is the honest price of keeping the two figures independent.
 */
export async function buildGrabPeriodSummary(
  buildGrid: (month: number, year: number, dayWindow?: DayWindow) => Promise<GrabGridResult>,
  month: number,
  year: number,
  range?: DateRange,
): Promise<{ base: GrabGridResult; range?: GrabRangeSummaryDto }> {
  if (!range) return { base: await buildGrid(month, year) };

  const slices = splitRangeByMonth(range);
  const [base, ...rangeGrids] = await Promise.all([
    buildGrid(month, year),
    ...slices.map((s) => buildGrid(s.month, s.year, { fromDay: s.fromDay, toDay: s.toDay })),
  ]);
  return { base, range: combineGrabRange(rangeGrids, range) };
}
