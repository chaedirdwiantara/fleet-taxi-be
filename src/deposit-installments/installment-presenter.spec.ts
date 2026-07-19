import { describe, expect, it } from 'vitest';
import {
  computeInstallments,
  filterRules,
  paginateRules,
  presentRule,
  sortRules,
  type DriverActiveDay,
  type InstallmentQuery,
  type InstallmentRule,
} from './installment-presenter';

const DRIVER = 'BUDI SANTOSO';

function rule(overrides: Partial<InstallmentRule> = {}): InstallmentRule {
  return {
    id: 1,
    partnerId: 10,
    title: 'Cicilan Deposit Budi',
    driverName: DRIVER,
    driverNameNorm: DRIVER,
    installmentAmount: 50_000,
    installmentCount: 10, // total 500.000
    minDailySetoran: 388_000,
    effectiveDate: '2026-07-01',
    note: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function day(date: string, setoranPaid: number, driverNameNorm = DRIVER): DriverActiveDay {
  return { driverNameNorm, date, setoranPaid };
}

describe('computeInstallments — surplus ledger', () => {
  it('pays only the surplus above the mandatory setoran, partially when short', () => {
    // setoran 423.000, min 388.000 → surplus 35.000 < nominal 50.000
    const entries = computeInstallments(rule(), [day('2026-07-10', 423_000)]);
    expect(entries).toEqual([
      {
        seq: 1,
        date: '2026-07-10',
        dailySetoran: 423_000,
        obligation: 388_000,
        amount: 35_000,
        paidCumulative: 35_000,
        arrearsAfter: 0,
      },
    ]);
  });

  it('surplus is uncapped: paying ahead lightens later days', () => {
    // day 1 surplus 120.000 (> nominal 50.000) — all of it is taken up front
    const entries = computeInstallments(rule(), [
      day('2026-07-01', 508_000), // surplus 120.000
      day('2026-07-02', 438_000), // surplus 50.000
    ]);
    expect(entries.map((e) => e.amount)).toEqual([120_000, 50_000]);
    expect(entries[1]!.paidCumulative).toBe(170_000);
  });

  it('a below-min day pays 0 and carries the setoran shortfall as tomorrow’s extra obligation', () => {
    const entries = computeInstallments(rule(), [
      day('2026-07-01', 300_000), // 88.000 short of the mandatory 388.000
      day('2026-07-02', 500_000), // must cover 388.000 + 88.000 first → surplus 24.000
    ]);
    expect(entries[0]).toMatchObject({ amount: 0, obligation: 388_000, arrearsAfter: 88_000 });
    expect(entries[1]).toMatchObject({
      obligation: 476_000,
      amount: 24_000,
      paidCumulative: 24_000,
      arrearsAfter: 0,
    });
  });

  it('arrears keep compounding across consecutive short days', () => {
    const entries = computeInstallments(rule(), [
      day('2026-07-01', 300_000), // arrears 88.000
      day('2026-07-02', 380_000), // obligation 476.000 → arrears 96.000
      day('2026-07-03', 490_000), // obligation 484.000 → surplus 6.000
    ]);
    expect(entries.map((e) => e.arrearsAfter)).toEqual([88_000, 96_000, 0]);
    expect(entries[2]!.amount).toBe(6_000);
  });

  it('payment is capped at the remaining total; the ledger stops at lunas', () => {
    const r = rule({ installmentAmount: 50_000, installmentCount: 2 }); // total 100.000
    const entries = computeInstallments(r, [
      day('2026-07-01', 478_000), // surplus 90.000
      day('2026-07-02', 488_000), // surplus 100.000 but only 10.000 remaining
      day('2026-07-03', 488_000), // after lunas — not in the ledger
    ]);
    expect(entries.map((e) => e.amount)).toEqual([90_000, 10_000]);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.paidCumulative).toBe(100_000);
  });

  it('skips days before effectiveDate and other drivers', () => {
    const entries = computeInstallments(rule({ effectiveDate: '2026-07-02' }), [
      day('2026-07-01', 500_000),
      day('2026-07-02', 438_000),
      day('2026-07-03', 500_000, 'ORANG LAIN'),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-02']);
  });

  it('exact-min day: surplus 0, no payment, but NO arrears either (inclusive boundary)', () => {
    const entries = computeInstallments(rule(), [day('2026-07-01', 388_000)]);
    expect(entries[0]).toMatchObject({ amount: 0, arrearsAfter: 0, obligation: 388_000 });
  });

  it('null min = classic fixed mode: one full installment per active day, no obligation', () => {
    const r = rule({ minDailySetoran: null, installmentAmount: 25_000, installmentCount: 3 });
    const entries = computeInstallments(r, [
      day('2026-07-01', 10_000), // setoran size is irrelevant in fixed mode
      day('2026-07-02', 0),
      day('2026-07-03', 999_999),
      day('2026-07-04', 100_000), // beyond lunas
    ]);
    expect(entries.map((e) => e.amount)).toEqual([25_000, 25_000, 25_000]);
    expect(entries.every((e) => e.obligation === 0 && e.arrearsAfter === 0)).toBe(true);
  });

  it('ledger days are processed in date order regardless of input order', () => {
    const entries = computeInstallments(rule(), [
      day('2026-07-03', 438_000),
      day('2026-07-01', 300_000),
      day('2026-07-02', 476_000),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    // arrears from day 1 must be settled on day 2, not day 3
    expect(entries.map((e) => e.arrearsAfter)).toEqual([88_000, 0, 0]);
  });
});

describe('presentRule', () => {
  it('derives totals, arrears, equivalent paidCount and status from the ledger', () => {
    const r = rule({ installmentAmount: 50_000, installmentCount: 10 });
    const entries = computeInstallments(r, [
      day('2026-07-01', 508_000), // +120.000
      day('2026-07-02', 300_000), // 0, arrears 88.000
    ]);
    const dto = presentRule(r, entries, 'B1234XYZ');
    expect(dto.totalPaid).toBe(120_000);
    expect(dto.totalTarget).toBe(500_000);
    expect(dto.remaining).toBe(380_000);
    expect(dto.paidCount).toBe(2); // floor(120.000 / 50.000)
    expect(dto.setoranArrears).toBe(88_000);
    expect(dto.status).toBe('berjalan');
    expect(dto.lastInstallmentDate).toBe('2026-07-01'); // last day that actually paid
    expect(dto.lastPlate).toBe('B1234XYZ');
  });

  it('lunas when the money target is reached; empty ledger → zeros', () => {
    const r = rule({ installmentAmount: 50_000, installmentCount: 1 });
    const full = presentRule(r, computeInstallments(r, [day('2026-07-01', 438_000)]), null);
    expect(full.status).toBe('lunas');
    expect(full.remaining).toBe(0);
    expect(full.paidCount).toBe(1);

    const empty = presentRule(r, [], null);
    expect(empty.totalPaid).toBe(0);
    expect(empty.setoranArrears).toBe(0);
    expect(empty.lastInstallmentDate).toBeNull();
    expect(empty.status).toBe('berjalan');
  });
});

describe('filter / sort / paginate', () => {
  const q = (o: Partial<InstallmentQuery> = {}): InstallmentQuery => ({
    sortBy: 'createdAt',
    sortOrder: 'desc',
    ...o,
  });
  const rows = [
    presentRule(
      rule({
        id: 1,
        title: 'Alpha',
        driverName: 'ANDI',
        driverNameNorm: 'ANDI',
        installmentAmount: 25_000,
        installmentCount: 1,
        minDailySetoran: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      }),
      computeInstallments(
        rule({
          driverNameNorm: 'ANDI',
          installmentAmount: 25_000,
          installmentCount: 1,
          minDailySetoran: null,
        }),
        [day('2026-07-01', 1, 'ANDI')],
      ),
      'B1AAA',
    ),
    presentRule(
      rule({
        id: 2,
        title: 'Bravo',
        driverName: 'BUDI SANTOSO',
        installmentAmount: 50_000,
        createdAt: new Date('2026-07-02T00:00:00Z'),
      }),
      [],
      'B2BBB',
    ),
  ];

  it('filters by status', () => {
    expect(filterRules(rows, q({ status: 'lunas' })).map((r) => r.id)).toEqual([1]);
    expect(filterRules(rows, q({ status: 'berjalan' })).map((r) => r.id)).toEqual([2]);
  });

  it('search matches title, driver and plate (case-insensitive)', () => {
    expect(filterRules(rows, q({ search: 'alp' })).map((r) => r.id)).toEqual([1]);
    expect(filterRules(rows, q({ search: 'budi' })).map((r) => r.id)).toEqual([2]);
    expect(filterRules(rows, q({ search: 'b2 bbb' })).map((r) => r.id)).toEqual([2]);
  });

  it('sorts by the displayed value, both directions, stable on id', () => {
    expect(
      sortRules(rows, q({ sortBy: 'installmentAmount', sortOrder: 'asc' })).map((r) => r.id),
    ).toEqual([1, 2]);
    expect(
      sortRules(rows, q({ sortBy: 'installmentAmount', sortOrder: 'desc' })).map((r) => r.id),
    ).toEqual([2, 1]);
    expect(sortRules(rows, q({ sortBy: 'title', sortOrder: 'desc' })).map((r) => r.id)).toEqual([
      2, 1,
    ]);
    expect(sortRules(rows, q({ sortBy: 'createdAt', sortOrder: 'desc' })).map((r) => r.id)).toEqual(
      [2, 1],
    );
  });

  it('paginates with a stable total', () => {
    const page = paginateRules(rows, 2, 1);
    expect(page.data).toHaveLength(1);
    expect(page.meta).toEqual({ page: 2, pageSize: 1, total: 2 });
  });
});
