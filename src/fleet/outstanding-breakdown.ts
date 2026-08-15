import type { MonitoringMode } from '../common/util/monitoring-mode';

/**
 * "Rincian Outstanding": why a row's running balance is what it is.
 *
 * A single all-history figure cannot be checked from the screen — a plate whose
 * current driver is fully settled still looks indebted because it carries the
 * remainder of everyone who drove it before. So the balance is broken down two
 * ways, and both are folded here from ONE SQL result so they can never disagree
 * with each other or with `outstanding`:
 *
 *  • parts  — WHO/WHICH PLATE contributed, and over which date range. The
 *    contributor is the opposite identity of the row itself: a plate row is
 *    detailed per driver, a driver row per plate.
 *  • months — WHICH MONTH moved the balance, with the running total after it,
 *    so "settled every month yet the total is huge" shows its cause.
 */

/** One (contributor × month) slice of the outstanding window, straight from SQL. */
export interface OutstandingSlice {
  /** The opposite identity: driver key in plate mode, plate norm in driver mode. */
  partKey: string;
  ym: string; // 'YYYY-MM'
  firstDate: string; // 'YYYY-MM-DD' — earliest row of this slice
  lastDate: string; // 'YYYY-MM-DD'
  due: number;
  paid: number;
}

export interface OutstandingPart {
  label: string;
  due: number;
  paid: number;
  delta: number; // due − paid: what this contributor left behind (negative = credit)
  from: string; // YYYY-MM-DD of its first row
  to: string;
}

export interface OutstandingMonth {
  ym: string; // YYYY-MM
  due: number;
  paid: number;
  delta: number;
  balance: number; // running balance after this month
}

export interface OutstandingBreakdown {
  parts: OutstandingPart[]; // chronological (earliest first row first)
  months: OutstandingMonth[]; // chronological
  /** Closing balance — equal to the row's `outstanding` by construction. */
  total: number;
  /** Contributors that left a non-zero remainder. */
  contributorCount: number;
  // The span of months that actually MOVED the balance, for the cell caption.
  // Null when nothing moved it (a row that never billed nor paid anything).
  rangeFrom: string | null; // YYYY-MM
  rangeTo: string | null;
}

/** Contributor with no identity of its own — its money still has to be visible. */
export const NO_DRIVER_LABEL = '(Tanpa nama driver)';
export const NO_PLATE_LABEL = '(Tanpa plat)';

/**
 * @param slices every (contributor × month) slice of ONE row subject
 * @param mode   the grid's row subject, which decides what a contributor is
 */
export function buildOutstandingBreakdown(
  slices: OutstandingSlice[],
  mode: MonitoringMode,
): OutstandingBreakdown {
  if (slices.length === 0) {
    return { parts: [], months: [], total: 0, contributorCount: 0, rangeFrom: null, rangeTo: null };
  }

  const emptyLabel = mode === 'driver' ? NO_PLATE_LABEL : NO_DRIVER_LABEL;
  const byPart = new Map<string, OutstandingPart>();
  const byMonth = new Map<string, { due: number; paid: number }>();

  for (const slice of slices) {
    const part = byPart.get(slice.partKey);
    if (part) {
      part.due += slice.due;
      part.paid += slice.paid;
      if (slice.firstDate < part.from) part.from = slice.firstDate;
      if (slice.lastDate > part.to) part.to = slice.lastDate;
    } else {
      byPart.set(slice.partKey, {
        label: slice.partKey || emptyLabel,
        due: slice.due,
        paid: slice.paid,
        delta: 0, // filled once the contributor's sums are complete
        from: slice.firstDate,
        to: slice.lastDate,
      });
    }

    const month = byMonth.get(slice.ym);
    if (month) {
      month.due += slice.due;
      month.paid += slice.paid;
    } else {
      byMonth.set(slice.ym, { due: slice.due, paid: slice.paid });
    }
  }

  const parts = [...byPart.values()]
    // A contributor with no money at all (e.g. a zero-valued handover day) would
    // only add an empty row to the popup.
    .filter((p) => p.due !== 0 || p.paid !== 0)
    .map((p) => ({ ...p, delta: p.due - p.paid }))
    // Read as a history: oldest first, so the running balance below it makes sense.
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  const months: OutstandingMonth[] = [];
  let balance = 0;
  let rangeFrom: string | null = null;
  let rangeTo: string | null = null;
  for (const ym of [...byMonth.keys()].sort()) {
    const { due, paid } = byMonth.get(ym)!;
    const delta = due - paid;
    balance += delta;
    months.push({ ym, due, paid, delta, balance });
    if (delta !== 0) {
      rangeFrom ??= ym;
      rangeTo = ym;
    }
  }

  return {
    parts,
    months,
    total: balance,
    contributorCount: parts.filter((p) => p.delta !== 0).length,
    rangeFrom,
    rangeTo,
  };
}
