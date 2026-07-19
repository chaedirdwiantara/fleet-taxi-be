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
    installmentAmount: 25000,
    installmentCount: 3,
    minDailySetoran: null,
    effectiveDate: '2026-07-01',
    note: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function day(date: string, setoranPaid: number, driverNameNorm = DRIVER): DriverActiveDay {
  return { driverNameNorm, date, setoranPaid };
}

describe('computeInstallments', () => {
  it('takes one installment per qualifying active day, ascending by date', () => {
    const entries = computeInstallments(rule({ installmentCount: 5 }), [
      day('2026-07-03', 100000),
      day('2026-07-01', 150000),
      day('2026-07-02', 120000),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries.every((e) => e.amount === 25000)).toBe(true);
  });

  it('skips days before effectiveDate', () => {
    const entries = computeInstallments(rule({ effectiveDate: '2026-07-02' }), [
      day('2026-07-01', 100000),
      day('2026-07-02', 100000),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-02']);
  });

  it('min gate is INCLUSIVE: setoran == min qualifies, below does not', () => {
    const entries = computeInstallments(rule({ minDailySetoran: 100000 }), [
      day('2026-07-01', 99999),
      day('2026-07-02', 100000),
      day('2026-07-03', 100001),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-02', '2026-07-03']);
    expect(entries[0]!.dailySetoran).toBe(100000);
  });

  it('null gate: every active day qualifies (even zero setoran)', () => {
    const entries = computeInstallments(rule(), [day('2026-07-01', 0)]);
    expect(entries).toHaveLength(1);
  });

  it('caps at installmentCount — extra qualifying days are ignored', () => {
    const entries = computeInstallments(
      rule({ installmentCount: 2 }),
      ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'].map((d) => day(d, 100000)),
    );
    expect(entries.map((e) => e.date)).toEqual(['2026-07-01', '2026-07-02']);
  });

  it('only matches the rule driver', () => {
    const entries = computeInstallments(rule(), [
      day('2026-07-01', 100000, 'ORANG LAIN'),
      day('2026-07-02', 100000),
    ]);
    expect(entries.map((e) => e.date)).toEqual(['2026-07-02']);
  });
});

describe('presentRule', () => {
  it('derives totals, remaining, status and lastInstallmentDate', () => {
    const r = rule({ installmentCount: 4, installmentAmount: 25000 });
    const entries = computeInstallments(r, [day('2026-07-01', 1), day('2026-07-02', 1)]);
    const dto = presentRule(r, entries, 'B1234XYZ');
    expect(dto.paidCount).toBe(2);
    expect(dto.totalPaid).toBe(50000);
    expect(dto.totalTarget).toBe(100000);
    expect(dto.remaining).toBe(50000);
    expect(dto.status).toBe('berjalan');
    expect(dto.lastInstallmentDate).toBe('2026-07-02');
    expect(dto.lastPlate).toBe('B1234XYZ');
  });

  it('status lunas when the duration is filled; empty history → null last date', () => {
    const r = rule({ installmentCount: 2 });
    const full = presentRule(
      r,
      computeInstallments(r, [day('2026-07-01', 1), day('2026-07-02', 1)]),
      null,
    );
    expect(full.status).toBe('lunas');
    expect(full.remaining).toBe(0);

    const empty = presentRule(r, [], null);
    expect(empty.paidCount).toBe(0);
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
        installmentCount: 1,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      }),
      [{ seq: 1, date: '2026-07-01', amount: 25000, dailySetoran: 1 }],
      'B1AAA',
    ),
    presentRule(
      rule({
        id: 2,
        title: 'Bravo',
        driverName: 'BUDI SANTOSO',
        installmentAmount: 50000,
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
