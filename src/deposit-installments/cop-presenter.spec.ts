import { describe, expect, it } from 'vitest';
import {
  COP_DAYS_PER_MONTH,
  filterCopRows,
  isCopTitle,
  presentCopRow,
  type CopQuery,
  type CopRowDto,
} from './cop-presenter';
import {
  computeInstallments,
  type DriverActiveDay,
  type InstallmentRule,
} from './installment-presenter';

const DRIVER = 'BUDI SANTOSO';
const DAILY = 35_000;
const TENOR = 60 * COP_DAYS_PER_MONTH; // 1800 cicilan harian = 60 bulan
const MIN_SETORAN = 388_000;

function rule(overrides: Partial<InstallmentRule> = {}): InstallmentRule {
  return {
    id: 1,
    partnerId: 10,
    title: 'COP (Car Ownership Program)',
    driverName: DRIVER,
    driverNameNorm: DRIVER,
    installmentAmount: DAILY,
    installmentCount: TENOR,
    minDailySetoran: MIN_SETORAN,
    effectiveDate: '2026-07-01',
    note: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function day(date: string, setoranPaid: number, driverNameNorm = DRIVER): DriverActiveDay {
  return { driverNameNorm, date, setoranPaid };
}

/** Builds the row through the REAL ledger so the spec can't drift from it. */
function row(r: InstallmentRule, days: DriverActiveDay[], lastPlate = 'B8801CIA'): CopRowDto {
  return presentCopRow(r, computeInstallments(r, days), lastPlate);
}

describe('isCopTitle', () => {
  it('matches the preset and hand-typed COP titles', () => {
    expect(isCopTitle('COP (Car Ownership Program)')).toBe(true);
    expect(isCopTitle('cop budi')).toBe(true);
    expect(isCopTitle('  COP')).toBe(true);
    expect(isCopTitle('COP-2026')).toBe(true);
  });

  it('does not match titles that merely start with the letters', () => {
    expect(isCopTitle('Copy deposit')).toBe(false);
    expect(isCopTitle('Cicilan Deposit')).toBe(false);
    expect(isCopTitle('E-Tilang')).toBe(false);
    expect(isCopTitle('Kontrakan COP')).toBe(false); // COP must lead the title
  });
});

describe('presentCopRow', () => {
  it('states the 60-month programme: 1800 × 35.000 = 63.000.000', () => {
    const r = row(rule(), []);
    expect(r.tenorMonths).toBe(60);
    expect(r.installmentCount).toBe(1800);
    expect(r.totalTarget).toBe(63_000_000);
    expect(r.remaining).toBe(63_000_000);
    expect(r.status).toBe('berjalan');
  });

  it('counts WITHDRAWALS, not active days — a zero-deduction day is not one', () => {
    const r = row(rule(), [
      day('2026-07-01', 423_000), // surplus 35.000 → potong penuh
      day('2026-07-02', 408_000), // surplus 20.000 → potong sebagian
      day('2026-07-03', 350_000), // di bawah setoran wajib → tidak ada potongan
      day('2026-07-04', 500_000), // wajib 388.000 + tunggakan 38.000 → surplus 74.000
    ]);

    expect(r.activeDays).toBe(4);
    expect(r.withdrawalCount).toBe(3);
    expect(r.firstWithdrawalDate).toBe('2026-07-01');
    expect(r.lastInstallmentDate).toBe('2026-07-04');
    expect(r.totalPaid).toBe(129_000); // 35.000 + 20.000 + 0 + 74.000
    expect(r.remaining).toBe(63_000_000 - 129_000);
  });

  it('gap = what those active days should have collected minus what they did', () => {
    const r = row(rule(), [
      day('2026-07-01', 423_000),
      day('2026-07-02', 408_000),
      day('2026-07-03', 350_000),
      day('2026-07-04', 500_000),
    ]);

    expect(r.scheduleDue).toBe(4 * DAILY); // 140.000
    expect(r.scheduleGap).toBe(140_000 - 129_000); // 11.000 tertinggal
  });

  it('reports a NEGATIVE gap when a strong day pays ahead of schedule', () => {
    const r = row(rule(), [day('2026-07-01', 600_000)]); // surplus 212.000
    expect(r.totalPaid).toBe(212_000);
    expect(r.scheduleDue).toBe(DAILY);
    expect(r.scheduleGap).toBe(DAILY - 212_000);
  });

  it('never lets the gap exceed the contract itself', () => {
    // 5 hari aktif atas program 2 cicilan: jadwal dibatasi total kewajiban
    const short = rule({ installmentCount: 2 });
    const r = row(
      short,
      ['01', '02', '03', '04', '05'].map((d) => day(`2026-07-${d}`, MIN_SETORAN + 10_000)),
    );

    expect(r.activeDays).toBe(5);
    expect(r.totalTarget).toBe(70_000);
    expect(r.totalPaid).toBe(50_000);
    expect(r.scheduleDue).toBe(70_000); // bukan 5 × 35.000
    expect(r.scheduleGap).toBe(r.remaining);
  });

  it('has no gap in fixed mode — every active day takes the full nominal', () => {
    const fixed = rule({ minDailySetoran: null, installmentCount: 3 });
    const r = row(fixed, [
      day('2026-07-01', 400_000),
      day('2026-07-02', 100_000),
      day('2026-07-03', 90_000),
    ]);

    expect(r.totalPaid).toBe(105_000);
    expect(r.scheduleGap).toBe(0);
    expect(r.status).toBe('lunas');
    expect(r.tenorMonths).toBe(0); // 3 cicilan harian belum genap sebulan
  });
});

describe('filterCopRows', () => {
  const query = (over: Partial<CopQuery> = {}): CopQuery => ({
    sortBy: 'remaining',
    sortOrder: 'desc',
    ...over,
  });
  const rows = (): CopRowDto[] => [
    row(rule(), []), // BUDI SANTOSO / B8801CIA
    row(rule({ id: 2, driverName: 'SUWANTO', driverNameNorm: 'SUWANTO' }), [], 'B2991UNS'),
  ];

  it('filters by status', () => {
    expect(filterCopRows(rows(), query({ status: 'lunas' }))).toEqual([]);
    expect(filterCopRows(rows(), query({ status: 'berjalan' }))).toHaveLength(2);
  });

  it('searches the driver name and the plate, ignoring plate punctuation', () => {
    expect(filterCopRows(rows(), query({ search: 'suwan' })).map((r) => r.id)).toEqual([2]);
    expect(filterCopRows(rows(), query({ search: 'b 8801 cia' })).map((r) => r.id)).toEqual([1]);
    expect(filterCopRows(rows(), query({ search: 'tidak ada' }))).toEqual([]);
  });
});
