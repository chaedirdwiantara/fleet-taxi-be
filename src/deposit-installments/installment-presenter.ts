/**
 * Presentation layer for Cicilan Deposit (partner portal). PURE: the service
 * feeds the rule rows plus per-driver daily aggregates already scoped to the
 * partner's registered plates; everything here is deterministic and
 * unit-testable without a database.
 *
 * Payment model — SURPLUS LEDGER (per business rule, 2026-07):
 * minDailySetoran is the driver's MANDATORY daily deposit; it is never taken
 * for the cicilan. Only the surplus above it pays the installment, partially
 * if needed, with carry-over in BOTH directions. History is DERIVED from
 * fleet imports, never stored — re-imports recompute it, double counting is
 * structurally impossible, and this function is the ONLY place the rule
 * lives (the legacy Evista port duplicated it in four code paths).
 *
 * For each active day d (>= effectiveDate, has >= 1 deduction row), in date
 * order, with running `arrears` (unpaid mandatory setoran) and `paid`:
 *   obligation = minDailySetoran + arrears        // mandatory first
 *   if setoran <  obligation → payment 0; arrears = obligation − setoran
 *   if setoran >= obligation → arrears = 0;
 *       payment = min(setoran − obligation, totalTarget − paid)
 * The surplus is UNCAPPED below the remaining total: paying ahead is allowed
 * (lightens later days); a shortfall simply leaves more to pay later.
 * LUNAS when paid reaches totalTarget = installmentAmount × installmentCount
 * — durasi defines the total, not a day limit.
 *
 * minDailySetoran = NULL disables the surplus model: classic fixed mode, one
 * full installmentAmount per active day until the total is reached (without a
 * mandatory floor, "surplus" would swallow the driver's entire setoran).
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

/** One ledger day. Days with amount 0 still appear: they explain the arrears. */
export interface InstallmentEntryDto {
  seq: number; // hari ke-N in the ledger (1-based)
  date: string; // 'YYYY-MM-DD'
  dailySetoran: number; // setoran paid that day
  obligation: number; // mandatory due that day: minDailySetoran + carried arrears (0 in fixed mode)
  amount: number; // potongan cicilan taken that day (0..remaining total)
  paidCumulative: number; // running cicilan total AFTER this day
  arrearsAfter: number; // unpaid mandatory setoran carried to the NEXT day
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
  paidCount: number; // full installments covered: min(count, floor(totalPaid / amount))
  totalPaid: number; // Σ ledger amounts
  totalTarget: number; // installmentAmount × installmentCount
  remaining: number; // totalTarget − totalPaid
  setoranArrears: number; // current unpaid mandatory setoran (0 in fixed mode)
  status: InstallmentStatus;
  lastInstallmentDate: string | null; // last day with amount > 0
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

// ---- the ONE ledger computation ----------------------------------------------

/** Derives the rule's payment ledger from the driver's active days. */
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
  const totalTarget = rule.installmentAmount * rule.installmentCount;
  const ordered = days
    .filter((d) => d.driverNameNorm === rule.driverNameNorm && d.date >= rule.effectiveDate)
    .sort((a, b) => a.date.localeCompare(b.date));

  const entries: InstallmentEntryDto[] = [];
  let paid = 0;
  let arrears = 0;

  for (const d of ordered) {
    if (paid >= totalTarget) break; // lunas — later days are not part of the ledger

    let obligation: number;
    let payment: number;
    if (rule.minDailySetoran == null) {
      // fixed mode: no mandatory floor — one full installment per active day
      obligation = 0;
      payment = Math.min(rule.installmentAmount, totalTarget - paid);
    } else {
      // surplus mode: mandatory setoran (incl. carried arrears) first
      obligation = rule.minDailySetoran + arrears;
      if (d.setoranPaid < obligation) {
        arrears = obligation - d.setoranPaid;
        payment = 0;
      } else {
        arrears = 0;
        payment = Math.min(d.setoranPaid - obligation, totalTarget - paid);
      }
    }

    paid += payment;
    entries.push({
      seq: entries.length + 1,
      date: d.date,
      dailySetoran: d.setoranPaid,
      obligation,
      amount: payment,
      paidCumulative: paid,
      arrearsAfter: arrears,
    });
  }

  return entries;
}

/** Rule + derived ledger → one API row. */
export function presentRule(
  rule: InstallmentRule,
  entries: InstallmentEntryDto[],
  lastPlate: string | null,
): InstallmentRuleDto {
  const last = entries.length > 0 ? entries[entries.length - 1]! : null;
  const totalPaid = last?.paidCumulative ?? 0;
  const totalTarget = rule.installmentAmount * rule.installmentCount;
  const lastPaidEntry = [...entries].reverse().find((e) => e.amount > 0) ?? null;
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
    paidCount: Math.min(rule.installmentCount, Math.floor(totalPaid / rule.installmentAmount)),
    totalPaid,
    totalTarget,
    remaining: totalTarget - totalPaid,
    setoranArrears: last?.arrearsAfter ?? 0,
    status: totalPaid >= totalTarget ? 'lunas' : 'berjalan',
    lastInstallmentDate: lastPaidEntry?.date ?? null,
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
