/**
 * The one place the partner's three income sources are merged into a single
 * subject × day matrix (All Fleet Monitoring). PURE — it takes the numbers the
 * source services already computed and only regroups them, so the page can never
 * invent money the Gojek / Grab / Rental screens don't show:
 *
 *   - Gojek  → counted setoran per day (`dailyCountedData`, the same figure the
 *              Gojek grid's "Total Deduction" sums)
 *   - Grab   → total earning collected per day (`dailyData`)
 *   - Rental → omset per day (price/day + the transaction's additionalCost once),
 *              from `rentalDailyIncome`
 *
 * Both reading modes consume the SAME inputs — the callers pass grids already
 * built in that mode — so `totals` is identical in either view. Anything that
 * cannot be attributed to the subject lands in the RESIDUAL row instead of being
 * dropped: in driver mode that is all rental omset (Rental Monitoring records no
 * driver) plus import rows with an empty driver name.
 */
import type { MonitoringMode } from '../common/util/monitoring-mode';
import type { DayFactsDto } from '../fleet/fleet-presenter';
import type { RentalDailyIncomeDto } from '../partner-rentals/rental-presenter';

export const ALL_FLEET_SOURCES = ['gojek', 'grab', 'rental'] as const;
export type AllFleetSource = (typeof ALL_FLEET_SOURCES)[number];

export type SourceAmounts = Record<AllFleetSource, number>;

/**
 * Gojek's own verdict on the day, carried verbatim so the combined matrix can
 * wear the same status colours as Gojek Monitoring (sesuai/kurang dari target,
 * Manual Payment, gabungan, bebas setoran, tidak beroperasi). PRESENTATION
 * ONLY — the money of the cell stays `gojek`/`total` above; nothing here is
 * ever summed.
 */
export interface AllFleetGojekDay extends DayFactsDto {
  /** That day's own due baseline (mid-month target changes), else the row's. */
  dailyTarget: number;
}

export interface AllFleetDayCell {
  gojek: number;
  grab: number;
  rental: number;
  total: number;
  /** The subject appears in that day's data but earned Rp 0 (pink cell). */
  isZero: boolean;
  /** Present when the Gojek grid had something for that day — money, a manual
   * payment, or an exception. Absent for Grab/Rental-only days (no target). */
  gojekDay?: AllFleetGojekDay;
}

/** One entry of the mirror-image history column: drivers of a plate, or plates
 * of a driver, with the day range it was seen in this month. */
export interface AllFleetHistoryEntry {
  label: string;
  sublabel: string | null; // vehicle type / city when known
  fromDay: number;
  toDay: number;
}

export interface AllFleetRow {
  key: string; // plate norm, or `drv:<NAME>`
  label: string; // plate (display form) or driver name
  sublabel: string | null; // "Denza · Jakarta" in plate mode
  history: AllFleetHistoryEntry[];
  days: Record<number, AllFleetDayCell>;
  totals: SourceAmounts & { total: number };
}

export interface AllFleetMatrix {
  rows: AllFleetRow[];
  /** Income that belongs to no subject in this mode; null when there is none. */
  residual: AllFleetRow | null;
  dailyTotals: Record<number, AllFleetDayCell>;
  totals: SourceAmounts & { total: number };
  subjectCount: number;
  activeCount: number; // subjects that actually earned something
}

// ---- inputs (already money-complete; this module only regroups) --------------

/**
 * One source's contribution to one subject. The CALLER decides the key, because
 * only it knows how its rows are shaped: the Gojek grid is keyed by plate, the
 * Grab grid by `plate|city|driver` — several Grab rows can therefore share the
 * same plate key, and merging them here is exactly the intent.
 *
 * `key` must be the plate norm in plate mode and `drv:<NAME>` in driver mode;
 * an empty `label` means "not attributable" and routes to the residual row.
 */
export interface AllFleetInputRow {
  key: string;
  label: string;
  sublabel?: string | null;
  /** Integer rupiah per day-of-month, already computed by the source service. */
  days: Record<number, number>;
  /** Days present in the source data that earned Rp 0 — lets the matrix tell
   * "no data" apart from "data, but nothing earned" (the pink cell). */
  zeroDays?: number[];
  /** Gojek only: that source's per-day status facts. Days listed here get a
   * cell even when they carry no money (a bebas-setoran day, or a Manual
   * Payment that does not count toward setoran) — otherwise the combined view
   * would silently hide what Gojek Monitoring shows in blue or purple. */
  gojekDays?: Record<number, AllFleetGojekDay>;
  /** The mirror subject: the drivers of this plate, or the plates of this driver. */
  history?: { label: string; sublabel?: string | null }[];
}

export interface BuildAllFleetInput {
  mode: MonitoringMode;
  daysInMonth: number;
  gojek: AllFleetInputRow[];
  grab: AllFleetInputRow[];
  /** Rental keeps its own DTO: the matrix owns the rule that rental omset has no
   * driver, so it must know which source it is looking at. */
  rental: RentalDailyIncomeDto[];
}

const RESIDUAL_KEY = 'residual';

function emptyCell(): AllFleetDayCell {
  return { gojek: 0, grab: 0, rental: 0, total: 0, isZero: false };
}

function emptyTotals(): SourceAmounts & { total: number } {
  return { gojek: 0, grab: 0, rental: 0, total: 0 };
}

/** Mutable row under construction — history is collected as day ranges. */
interface Draft extends Omit<AllFleetRow, 'history'> {
  historyRanges: Map<string, { label: string; sublabel: string | null; from: number; to: number }>;
}

function draft(key: string, label: string, sublabel: string | null): Draft {
  return { key, label, sublabel, days: {}, totals: emptyTotals(), historyRanges: new Map() };
}

function add(
  row: Draft,
  source: AllFleetSource,
  days: Record<number, number>,
  daysInMonth: number,
): void {
  for (const [dayKey, amount] of Object.entries(days)) {
    const day = Number(dayKey);
    if (day < 1 || day > daysInMonth) continue; // dirty data: out of the month
    const cell = (row.days[day] ??= emptyCell());
    cell[source] += amount;
    cell.total += amount;
    row.totals[source] += amount;
    row.totals.total += amount;
  }
}

/** Mark days the subject appears in with Rp 0 — same meaning as the pink cell in
 * Gojek Monitoring: there IS data, it just did not earn. */
function markZeroDays(row: Draft, zeroDays: number[], daysInMonth: number): void {
  for (const day of zeroDays) {
    if (day < 1 || day > daysInMonth) continue;
    const cell = (row.days[day] ??= emptyCell());
    if (cell.total === 0) cell.isZero = true;
  }
}

/**
 * Attach Gojek's per-day status to the subject's cells, CREATING a cell for a
 * day that carries no money (bebas setoran, tidak beroperasi, or a Manual
 * Payment that does not count toward setoran). Deliberately touches no amount:
 * `add()` is the only place money accrues, so every total is unchanged.
 */
function attachGojekDays(
  row: Draft,
  gojekDays: Record<number, AllFleetGojekDay>,
  daysInMonth: number,
): void {
  for (const [dayKey, facts] of Object.entries(gojekDays)) {
    const day = Number(dayKey);
    if (day < 1 || day > daysInMonth) continue;
    const cell = (row.days[day] ??= emptyCell());
    cell.gojekDay = facts;
  }
}

function trackHistory(
  row: Draft,
  label: string,
  sublabel: string | null,
  days: Record<number, number>,
  daysInMonth: number,
): void {
  const activeDays = Object.keys(days)
    .map(Number)
    .filter((d) => d >= 1 && d <= daysInMonth);
  if (!activeDays.length || label === '') return;
  const from = Math.min(...activeDays);
  const to = Math.max(...activeDays);
  const seen = row.historyRanges.get(label);
  if (seen) {
    seen.from = Math.min(seen.from, from);
    seen.to = Math.max(seen.to, to);
    if (!seen.sublabel && sublabel) seen.sublabel = sublabel;
  } else {
    row.historyRanges.set(label, { label, sublabel, from, to });
  }
}

function finalize(row: Draft): AllFleetRow {
  const { historyRanges, ...rest } = row;
  return {
    ...rest,
    history: [...historyRanges.values()]
      .sort((a, b) => a.from - b.from || a.label.localeCompare(b.label))
      .map((h) => ({ label: h.label, sublabel: h.sublabel, fromDay: h.from, toDay: h.to })),
  };
}

/**
 * Merge the three sources into the matrix. Rows are sorted by total income
 * descending (the reading order of the legacy page: biggest earner first), with
 * the label as a stable tiebreaker.
 */
export function buildAllFleetMatrix(input: BuildAllFleetInput): AllFleetMatrix {
  const { mode, daysInMonth } = input;
  const byDriver = mode === 'driver';
  const drafts = new Map<string, Draft>();
  const residual = draft(RESIDUAL_KEY, byDriver ? 'Tanpa driver' : 'Tanpa plat', null);
  let hasResidual = false;

  const target = (key: string, label: string, sublabel: string | null): Draft => {
    // A driver row with no name, or a plate row with no plate, has no subject to
    // attribute to — that money belongs in the residual row, not in a blank one.
    if (label === '') {
      hasResidual = true;
      return residual;
    }
    const existing = drafts.get(key);
    if (existing) {
      if (!existing.sublabel && sublabel) existing.sublabel = sublabel;
      return existing;
    }
    const created = draft(key, label, sublabel);
    drafts.set(key, created);
    return created;
  };

  const absorb = (source: AllFleetSource, inputRows: AllFleetInputRow[]) => {
    for (const subject of inputRows) {
      const row = target(subject.key, subject.label, subject.sublabel ?? null);
      add(row, source, subject.days, daysInMonth);
      markZeroDays(row, subject.zeroDays ?? [], daysInMonth);
      // Only a real subject has a target to be measured against; the residual
      // row pools many of them, so a per-day verdict there would be a fiction.
      if (subject.gojekDays && row !== residual) {
        attachGojekDays(row, subject.gojekDays, daysInMonth);
      }
      for (const entry of subject.history ?? []) {
        trackHistory(row, entry.label, entry.sublabel ?? null, subject.days, daysInMonth);
      }
    }
  };

  absorb('gojek', input.gojek);
  absorb('grab', input.grab);

  for (const plate of input.rental) {
    // Rental Monitoring records the customer, never a driver — in driver mode the
    // omset is real but ownerless, so it goes to the residual row instead of
    // being silently left out of the table (the card totals include it).
    if (byDriver) {
      hasResidual = true;
      add(residual, 'rental', plate.days, daysInMonth);
      trackHistory(residual, plate.plateNorm, plate.vehicleType, plate.days, daysInMonth);
      continue;
    }
    const sublabel = [plate.vehicleType, plate.region].filter(Boolean).join(' · ') || null;
    const row = target(plate.plateNorm, plate.plateNumber || plate.plateNorm, sublabel);
    add(row, 'rental', plate.days, daysInMonth);
  }

  const rows = [...drafts.values()]
    .map(finalize)
    .sort((a, b) => b.totals.total - a.totals.total || a.label.localeCompare(b.label));

  const dailyTotals: Record<number, AllFleetDayCell> = {};
  const totals = emptyTotals();
  for (const row of [...rows, ...(hasResidual ? [finalize(residual)] : [])]) {
    for (const [dayKey, cell] of Object.entries(row.days)) {
      const day = Number(dayKey);
      const agg = (dailyTotals[day] ??= emptyCell());
      for (const source of ALL_FLEET_SOURCES) agg[source] += cell[source];
      agg.total += cell.total;
    }
    for (const source of ALL_FLEET_SOURCES) totals[source] += row.totals[source];
    totals.total += row.totals.total;
  }

  return {
    rows,
    residual: hasResidual ? finalize(residual) : null,
    dailyTotals,
    totals,
    subjectCount: rows.length,
    activeCount: rows.filter((r) => r.totals.total !== 0).length,
  };
}
