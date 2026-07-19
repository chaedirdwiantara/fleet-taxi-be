/**
 * Presentation layer for Cicilan Deposit (partner portal). PURE: the service
 * feeds the rule rows plus per-driver daily aggregates already scoped to the
 * partner's registered plates; everything here is deterministic and
 * unit-testable without a database.
 *
 * Flow (port of the legacy Evista "Income Cuts", with its known flaws fixed):
 * - Installment history is DERIVED, never stored. A calendar date `d` yields
 *   exactly one installment for a rule when ALL hold:
 *     1. d >= effectiveDate
 *     2. d is an "active day" of the rule's driver (>= 1 deduction row in
 *        fleet_import_details over the partner's plates)
 *     3. minDailySetoran is null OR that day's setoran paid >= minDailySetoran
 *        (INCLUSIVE — the legacy strict `<` was ambiguous)
 *     4. the date's ascending ordinal <= installmentCount (durasi cap)
 *   One date = one installment, so double counting is structurally impossible
 *   (legacy bug: log table without a unique constraint).
 * - This function is the ONLY place the qualification rule lives (legacy bug:
 *   the same logic duplicated in four code paths).
 */

// ---- service → presenter inputs ---------------------------------------------

export interface InstallmentRule {
  id: number;
  partnerId: number;
  title: string;
  driverName: string;
  driverNameNorm: string;
  installmentAmount: number;
  installmentCount: number;
  minDailySetoran: number | null;
  effectiveDate: string; // 'YYYY-MM-DD'
  note: string | null;
  createdAt: Date;
}

/** One active day of one driver, partner-scoped, aggregated across plates. */
export interface DriverActiveDay {
  driverNameNorm: string;
  date: string; // 'YYYY-MM-DD'
  setoranPaid: number; // integer rupiah paid that day (deduction + manual masuk setoran)
}

// ---- API DTOs ----------------------------------------------------------------

export type InstallmentStatus = 'berjalan' | 'lunas';

export interface InstallmentEntryDto {
  seq: number; // cicilan ke-N (1-based)
  date: string; // 'YYYY-MM-DD'
  amount: number; // = rule.installmentAmount
  dailySetoran: number; // that day's setoran paid (context for the gate)
}

export interface InstallmentRuleDto {
  id: number;
  title: string;
  driverName: string;
  lastPlate: string | null;
  installmentAmount: number;
  installmentCount: number;
  minDailySetoran: number | null;
  effectiveDate: string;
  note: string | null;
  createdAt: string; // ISO timestamp
  paidCount: number;
  totalPaid: number; // paidCount × installmentAmount
  totalTarget: number; // installmentAmount × installmentCount
  remaining: number; // totalTarget − totalPaid
  status: InstallmentStatus;
  lastInstallmentDate: string | null;
}

export const INSTALLMENT_SORT_FIELDS = [
  'title',
  'createdAt',
  'effectiveDate',
  'driverName',
  'installmentAmount',
  'installmentCount',
  'totalTarget',
  'totalPaid',
  'remaining',
] as const;
export type InstallmentSortField = (typeof INSTALLMENT_SORT_FIELDS)[number];

export interface InstallmentQuery {
  status?: InstallmentStatus;
  search?: string;
  sortBy: InstallmentSortField;
  sortOrder: 'asc' | 'desc';
}

// ---- the ONE qualification/computation function ------------------------------

/** Derives the rule's installment history from the driver's active days. */
export function computeInstallments(
  rule: Pick<
    InstallmentRule,
    | 'driverNameNorm'
    | 'effectiveDate'
    | 'minDailySetoran'
    | 'installmentCount'
    | 'installmentAmount'
  >,
  days: DriverActiveDay[],
): InstallmentEntryDto[] {
  return days
    .filter(
      (d) =>
        d.driverNameNorm === rule.driverNameNorm &&
        d.date >= rule.effectiveDate &&
        (rule.minDailySetoran == null || d.setoranPaid >= rule.minDailySetoran),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, rule.installmentCount)
    .map((d, i) => ({
      seq: i + 1,
      date: d.date,
      amount: rule.installmentAmount,
      dailySetoran: d.setoranPaid,
    }));
}

/** Rule + derived history → one API row. */
export function presentRule(
  rule: InstallmentRule,
  entries: InstallmentEntryDto[],
  lastPlate: string | null,
): InstallmentRuleDto {
  const paidCount = entries.length;
  const totalPaid = paidCount * rule.installmentAmount;
  const totalTarget = rule.installmentAmount * rule.installmentCount;
  return {
    id: rule.id,
    title: rule.title,
    driverName: rule.driverName,
    lastPlate,
    installmentAmount: rule.installmentAmount,
    installmentCount: rule.installmentCount,
    minDailySetoran: rule.minDailySetoran,
    effectiveDate: rule.effectiveDate,
    note: rule.note,
    createdAt: rule.createdAt.toISOString(),
    paidCount,
    totalPaid,
    totalTarget,
    remaining: totalTarget - totalPaid,
    status: paidCount >= rule.installmentCount ? 'lunas' : 'berjalan',
    lastInstallmentDate: entries.length > 0 ? entries[entries.length - 1]!.date : null,
  };
}

// ---- filter / sort / paginate (same pure pipeline debt-summary used) ---------

export function filterRules(rows: InstallmentRuleDto[], q: InstallmentQuery): InstallmentRuleDto[] {
  let out = rows;
  if (q.status) out = out.filter((r) => r.status === q.status);
  const needle = (q.search ?? '').trim().toUpperCase();
  if (needle) {
    out = out.filter(
      (r) =>
        r.title.toUpperCase().includes(needle) ||
        r.driverName.toUpperCase().includes(needle) ||
        (r.lastPlate ?? '').toUpperCase().includes(needle.replace(/[^A-Z0-9]/g, '')),
    );
  }
  return out;
}

/** Every sortable field maps 1:1 to the DISPLAYED value (legacy bug: mislabeled sorts). */
export function sortRules(rows: InstallmentRuleDto[], q: InstallmentQuery): InstallmentRuleDto[] {
  const dir = q.sortOrder === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[q.sortBy];
    const vb = b[q.sortBy];
    const cmp =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'id');
    // stable tiebreaker so pagination never shows a row twice
    return dir * cmp || a.id - b.id;
  });
}

export function paginateRules(
  rows: InstallmentRuleDto[],
  page: number,
  pageSize: number,
): { data: InstallmentRuleDto[]; meta: { page: number; pageSize: number; total: number } } {
  const start = (page - 1) * pageSize;
  return {
    data: rows.slice(start, start + pageSize),
    meta: { page, pageSize, total: rows.length },
  };
}
