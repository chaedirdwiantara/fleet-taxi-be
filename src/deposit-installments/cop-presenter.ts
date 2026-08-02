/**
 * Presentation layer for the Car Ownership Program (COP) report. PURE — same
 * contract as installment-presenter.ts: the service hands over the already
 * partner-scoped rules plus their derived ledgers, everything here is
 * deterministic and unit-testable without a database.
 *
 * COP is NOT a second payment model. A COP row IS a Cicilan rule whose title is
 * the COP preset, so `presentCopRow()` builds on `presentRule()` and only adds
 * the program-level figures the report needs. That is why `CopRowDto` extends
 * `InstallmentRuleDto`: one vocabulary, one ledger, no duplicated arithmetic.
 *
 * Tenor lives in the existing `installmentCount` as a number of DAILY
 * installments — a 60-month program at Rp 35.000/day is 60 × 30 = 1.800
 * installments (Rp 63.000.000 total).
 *
 * Two different "sisa" figures, deliberately kept apart:
 *   - `remaining`   (inherited) = totalTarget − totalPaid — the whole contract
 *                   still outstanding, regardless of time.
 *   - `scheduleGap` = what the ledger SHOULD have collected over the driver's
 *                   active days minus what it actually collected. Positive =
 *                   behind schedule; negative = paid ahead (surplus mode may
 *                   take more than the nominal on a strong day).
 */

import {
  presentRule,
  type InstallmentEntryDto,
  type InstallmentRule,
  type InstallmentRuleDto,
  type InstallmentStatus,
} from './installment-presenter';

/** Program convention: one month of the tenor = 30 daily installments. */
export const COP_DAYS_PER_MONTH = 30;

/**
 * A rule belongs to the COP report when its title starts with COP as a WHOLE
 * word — matches 'COP (Car Ownership Program)' (the preset the partner picks)
 * and hand-typed variants like 'COP Budi', while 'Copy deposit' stays out.
 */
export function isCopTitle(title: string): boolean {
  return /^\s*COP\b/i.test(title);
}

export interface CopRowDto extends InstallmentRuleDto {
  /** installmentCount ÷ 30, rounded — 1.800 daily installments ⇒ 60 months. */
  tenorMonths: number;
  /** Ledger days recorded so far (active days ≥ effectiveDate). */
  activeDays: number;
  /** How many TIMES money was actually taken (days with a deduction > 0). */
  withdrawalCount: number;
  firstWithdrawalDate: string | null;
  /** What the schedule should have collected over those active days. */
  scheduleDue: number;
  /** scheduleDue − totalPaid. > 0 behind schedule, < 0 paid ahead. */
  scheduleGap: number;
}

export interface CopSummaryDto {
  driverCount: number;
  ruleCount: number;
  berjalanCount: number;
  lunasCount: number;
  totalTarget: number;
  totalPaid: number;
  totalRemaining: number;
  /** Σ of the POSITIVE gaps only — paid-ahead rows must not mask arrears. */
  totalGap: number;
  totalWithdrawals: number;
}

export const COP_SORT_FIELDS = [
  'driverName',
  'effectiveDate',
  'createdAt',
  'totalTarget',
  'totalPaid',
  'remaining',
  'scheduleGap',
  'withdrawalCount',
] as const;
export type CopSortField = (typeof COP_SORT_FIELDS)[number];

export interface CopQuery {
  status?: InstallmentStatus;
  search?: string;
  sortBy: CopSortField;
  sortOrder: 'asc' | 'desc';
}

/** Rule + derived ledger → one COP report row. */
export function presentCopRow(
  rule: InstallmentRule,
  entries: InstallmentEntryDto[],
  lastPlate: string | null,
): CopRowDto {
  const base = presentRule(rule, entries, lastPlate);
  const withdrawals = entries.filter((e) => e.amount > 0);
  // Capped at the contract total: a run of partial days can outnumber the
  // installments without ever owing more than the programme itself.
  const scheduleDue = Math.min(entries.length * rule.installmentAmount, base.totalTarget);

  return {
    ...base,
    tenorMonths: Math.round(rule.installmentCount / COP_DAYS_PER_MONTH),
    activeDays: entries.length,
    withdrawalCount: withdrawals.length,
    firstWithdrawalDate: withdrawals[0]?.date ?? null,
    scheduleDue,
    scheduleGap: scheduleDue - base.totalPaid,
  };
}

/** Programme totals across EVERY matching row (never just the current page). */
export function summarizeCop(rows: CopRowDto[]): CopSummaryDto {
  const summary: CopSummaryDto = {
    driverCount: new Set(rows.map((r) => r.driverName)).size,
    ruleCount: rows.length,
    berjalanCount: 0,
    lunasCount: 0,
    totalTarget: 0,
    totalPaid: 0,
    totalRemaining: 0,
    totalGap: 0,
    totalWithdrawals: 0,
  };

  for (const row of rows) {
    if (row.status === 'lunas') summary.lunasCount += 1;
    else summary.berjalanCount += 1;
    summary.totalTarget += row.totalTarget;
    summary.totalPaid += row.totalPaid;
    summary.totalRemaining += row.remaining;
    summary.totalGap += Math.max(0, row.scheduleGap);
    summary.totalWithdrawals += row.withdrawalCount;
  }
  return summary;
}

/**
 * Status + free-text filter. Titles are all COP here, so the search targets
 * what actually distinguishes rows: the driver and their plate.
 */
export function filterCopRows(rows: CopRowDto[], q: CopQuery): CopRowDto[] {
  let out = rows;
  if (q.status) out = out.filter((r) => r.status === q.status);
  const needle = (q.search ?? '').trim().toUpperCase();
  if (needle) {
    out = out.filter(
      (r) =>
        r.driverName.toUpperCase().includes(needle) ||
        (r.lastPlate ?? '').toUpperCase().includes(needle.replace(/[^A-Z0-9]/g, '')),
    );
  }
  return out;
}
