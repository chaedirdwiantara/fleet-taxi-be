/**
 * Display-side helpers for the Gojek grid's target column.
 *
 * IMPORTANT: nothing here produces money. The billable obligation
 * (`calculatedTarget`) is the sum of the `due` rows that were actually
 * imported, and it comes from fetchCumulativeStats' `month_target` — the same
 * SQL aggregate that already backs `outstanding`, exclusions included. These
 * helpers only describe that obligation for the UI: the representative daily
 * rate shown in the "Setoran" column (and used as a cell-tone baseline) and the
 * span of days the bill actually covers.
 */
import { DEFAULT_DAILY_TARGET } from './gojek-grid.types';

/** Per-day Σ|due| for a plate, keyed by day-of-month. */
export type DailyDue = Record<number, number>;

export interface BilledWindow {
  /** How many days in the month carry a (non-waived) due row. */
  billedDays: number;
  /** First and last of those days — null when nothing was billed. */
  billFromDay: number | null;
  billToDay: number | null;
}

/**
 * The daily rate to DISPLAY for a plate.
 *
 * An explicit fleet_targets entry always wins. Otherwise we take the **mode**
 * of the observed daily dues rather than their mean: when the rate changes
 * mid-month (Rp 500.000 for two days, then Rp 450.000 for twenty) the mean is a
 * number the driver was never charged, while the mode is the rate actually in
 * force. Ties resolve to the later day, so a fresh rate wins over the one it
 * replaced. With no due rows at all there is nothing to infer from, and the
 * constant fallback keeps the cell-tone baseline non-zero (a zero baseline
 * would tone every paid cell green).
 */
export function dailyTargetFrom(dailyDue: DailyDue, manualTarget: number): number {
  if (manualTarget > 0) return manualTarget;

  let best = 0;
  let bestCount = 0;
  let bestDay = -1;
  const counts = new Map<number, { count: number; lastDay: number }>();

  for (const [dayKey, amount] of Object.entries(dailyDue)) {
    if (amount <= 0) continue;
    const day = Number(dayKey);
    const seen = counts.get(amount);
    const count = (seen?.count ?? 0) + 1;
    const lastDay = Math.max(seen?.lastDay ?? 0, day);
    counts.set(amount, { count, lastDay });

    if (count > bestCount || (count === bestCount && lastDay > bestDay)) {
      best = amount;
      bestCount = count;
      bestDay = lastDay;
    }
  }

  return best > 0 ? best : DEFAULT_DAILY_TARGET;
}

/**
 * The span the bill covers: days that carry a due row, minus days waived as
 * bebas-setoran (explicit fleet_exceptions or a Rental Monitoring booking).
 * Mirrors the exclusions in fetchCumulativeStats' SQL so the caption can never
 * claim more days than the amount was summed over.
 */
export function billedWindow(dailyDue: DailyDue, freeDays: ReadonlySet<number>): BilledWindow {
  let billedDays = 0;
  let billFromDay: number | null = null;
  let billToDay: number | null = null;

  for (const [dayKey, amount] of Object.entries(dailyDue)) {
    if (amount <= 0) continue;
    const day = Number(dayKey);
    if (freeDays.has(day)) continue;
    billedDays++;
    if (billFromDay === null || day < billFromDay) billFromDay = day;
    if (billToDay === null || day > billToDay) billToDay = day;
  }

  return { billedDays, billFromDay, billToDay };
}
