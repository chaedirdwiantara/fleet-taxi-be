import { describe, expect, it } from 'vitest';
import { rentals } from '../db/schema';
import {
  currentPeriodWib,
  daysInclusive,
  matchesSearch,
  monthBounds,
  nettByType,
  presentRental,
  slugifyCogsKey,
  sortRentalItems,
  summarizeRentals,
} from './rental-presenter';

type RentalRow = typeof rentals.$inferSelect;

function row(overrides: Partial<RentalRow> = {}): RentalRow {
  return {
    id: 1,
    partnerId: 10,
    plateNumber: 'B 1793 SCP',
    plateNumberNorm: 'B1793SCP',
    vehicleType: 'Air EV',
    region: 'Jakarta',
    startDate: '2026-07-01',
    endDate: '2026-07-27',
    pricePerDay: 450_000,
    cogsPerDay: 335_833,
    cogsType: 'Air EV',
    additionalCost: 0,
    additionalCostDescription: null,
    deposit: 0,
    rentalType: 'Lepas Kunci',
    infoSource: null,
    serviceArea: null,
    customerName: 'Budi',
    customerPhone: null,
    paymentStatus: 'Belum Dibayar',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

describe('daysInclusive / monthBounds', () => {
  it('counts inclusively: 01 → 27 = 27 days', () => {
    expect(daysInclusive('2026-07-01', '2026-07-27')).toBe(27);
    expect(daysInclusive('2026-07-05', '2026-07-05')).toBe(1);
    expect(daysInclusive('2026-07-01', '2026-07-31')).toBe(31);
  });

  it('spans month/year edges and leap days', () => {
    expect(daysInclusive('2026-06-28', '2026-07-02')).toBe(5);
    expect(daysInclusive('2024-02-28', '2024-03-01')).toBe(3); // leap year
  });

  it('computes month bounds incl. leap February', () => {
    expect(monthBounds(2026, 7)).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(monthBounds(2024, 2)).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(monthBounds(2026, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
});

describe('presentRental — month clipping & money formulas', () => {
  it('keeps the full range when it fits the month', () => {
    const item = presentRental(row(), { year: 2026, month: 7 });
    expect(item.displayStartDate).toBe('2026-07-01');
    expect(item.displayEndDate).toBe('2026-07-27');
    expect(item.days).toBe(27);
    expect(item.gross).toBe(450_000 * 27);
    expect(item.cogsTotal).toBe(335_833 * 27);
    expect(item.nettProfit).toBe(item.gross - item.cogsTotal);
    expect(item.omset).toBe(item.gross);
    // Full stored range preserved for edit forms
    expect(item.startDate).toBe('2026-07-01');
    expect(item.endDate).toBe('2026-07-27');
  });

  it('clips a cross-month rental to the selected month on both sides', () => {
    const r = row({ startDate: '2026-06-20', endDate: '2026-08-05' });
    const july = presentRental(r, { year: 2026, month: 7 });
    expect(july.displayStartDate).toBe('2026-07-01');
    expect(july.displayEndDate).toBe('2026-07-31');
    expect(july.days).toBe(31);
    expect(july.startDate).toBe('2026-06-20'); // stored range untouched

    const june = presentRental(r, { year: 2026, month: 6 });
    expect(june.displayStartDate).toBe('2026-06-20');
    expect(june.displayEndDate).toBe('2026-06-30');
    expect(june.days).toBe(11);
  });

  it('counts additionalCost once in full (per transaction, not per day)', () => {
    const r = row({
      startDate: '2026-06-20',
      endDate: '2026-07-10',
      pricePerDay: 100_000,
      cogsPerDay: 40_000,
      additionalCost: 250_000,
    });
    const july = presentRental(r, { year: 2026, month: 7 });
    expect(july.days).toBe(10);
    expect(july.gross).toBe(1_000_000);
    expect(july.cogsTotal).toBe(400_000);
    expect(july.nettProfit).toBe(1_000_000 - 400_000 - 250_000);
    expect(july.omset).toBe(1_000_000 + 250_000);
    // …and again in full in June (legacy behavior)
    const june = presentRental(r, { year: 2026, month: 6 });
    expect(june.omset).toBe(11 * 100_000 + 250_000);
  });

  it('presents unclipped when no month is given (create/update response)', () => {
    const item = presentRental(row({ startDate: '2026-06-20', endDate: '2026-08-05' }));
    expect(item.displayStartDate).toBe('2026-06-20');
    expect(item.displayEndDate).toBe('2026-08-05');
    expect(item.days).toBe(daysInclusive('2026-06-20', '2026-08-05'));
  });
});

describe('sortRentalItems', () => {
  const items = [
    presentRental(row({ id: 1, startDate: '2026-07-10', endDate: '2026-07-12' }), {
      year: 2026,
      month: 7,
    }),
    presentRental(
      row({ id: 2, startDate: '2026-07-01', endDate: '2026-07-20', pricePerDay: 1_000 }),
      { year: 2026, month: 7 },
    ),
    presentRental(
      row({
        id: 3,
        startDate: '2026-07-05',
        endDate: '2026-07-05',
        paymentStatus: 'Sudah Dibayar',
      }),
      { year: 2026, month: 7 },
    ),
  ];

  it('sorts by displayStartDate asc/desc', () => {
    expect(sortRentalItems(items, 'date', 'asc').map((i) => i.id)).toEqual([2, 3, 1]);
    expect(sortRentalItems(items, 'date', 'desc').map((i) => i.id)).toEqual([1, 3, 2]);
  });

  it('sorts by duration, omset, cogs and status', () => {
    expect(sortRentalItems(items, 'duration', 'asc').map((i) => i.id)).toEqual([3, 1, 2]);
    expect(sortRentalItems(items, 'omset', 'desc')[0]!.omset).toBe(
      Math.max(...items.map((i) => i.omset)),
    );
    expect(sortRentalItems(items, 'cogs', 'asc')[0]!.cogsTotal).toBe(
      Math.min(...items.map((i) => i.cogsTotal)),
    );
    expect(sortRentalItems(items, 'status', 'asc')[0]!.paymentStatus).toBe('Belum Dibayar');
    expect(sortRentalItems(items, 'status', 'desc')[0]!.paymentStatus).toBe('Sudah Dibayar');
  });

  it('does not mutate the input array', () => {
    const before = items.map((i) => i.id);
    sortRentalItems(items, 'date', 'desc');
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('summarizeRentals', () => {
  it('splits paid/unpaid aggregates and derives paidNettProfit', () => {
    const paid = presentRental(
      row({
        paymentStatus: 'Sudah Dibayar',
        startDate: '2026-07-01',
        endDate: '2026-07-10',
        pricePerDay: 100_000,
        cogsPerDay: 30_000,
        additionalCost: 50_000,
      }),
      { year: 2026, month: 7 },
    );
    const unpaid = presentRental(
      row({ startDate: '2026-07-01', endDate: '2026-07-02', pricePerDay: 200_000 }),
      { year: 2026, month: 7 },
    );
    const s = summarizeRentals([paid, unpaid]);
    expect(s).toEqual({
      totalTransactions: 2,
      unpaidTransactions: 1,
      unpaidGross: 400_000,
      paidGross: 1_000_000,
      paidCogs: 300_000,
      paidAdditionalCost: 50_000,
      paidNettProfit: 650_000,
    });
  });

  it('is all zeros for an empty month', () => {
    expect(summarizeRentals([])).toEqual({
      totalTransactions: 0,
      unpaidTransactions: 0,
      unpaidGross: 0,
      paidGross: 0,
      paidCogs: 0,
      paidAdditionalCost: 0,
      paidNettProfit: 0,
    });
  });
});

describe('nettByType', () => {
  it('aggregates paid-only per cogsType, falls back to Lainnya, sorts by nett desc', () => {
    const clip = { year: 2026, month: 7 };
    const mk = (cogsType: string | null, pricePerDay: number, paymentStatus = 'Sudah Dibayar') =>
      presentRental(
        row({
          cogsType,
          pricePerDay,
          cogsPerDay: 0,
          startDate: '2026-07-01',
          endDate: '2026-07-01',
          paymentStatus,
        }),
        clip,
      );
    const result = nettByType([
      mk('Seal', 100_000),
      mk('Seal', 50_000),
      mk(null, 500_000),
      mk('  ', 1_000),
      mk('Ioniq', 999_999_999, 'Belum Dibayar'), // unpaid → excluded
    ]);
    expect(result.map((r) => r.cogsType)).toEqual(['Lainnya', 'Seal']);
    expect(result[0]).toEqual({
      cogsType: 'Lainnya',
      gross: 501_000,
      cogs: 0,
      nett: 501_000,
      count: 2,
    });
    expect(result[1]!.count).toBe(2);
    expect(result[1]!.nett).toBe(150_000);
  });
});

describe('matchesSearch', () => {
  const item = presentRental(row({ customerName: 'Budi Santoso', serviceArea: 'Jabodetabek' }), {
    year: 2026,
    month: 7,
  });
  it('matches plate, customer or service area, case-insensitively', () => {
    expect(matchesSearch(item, '1793')).toBe(true);
    expect(matchesSearch(item, 'budi')).toBe(true);
    expect(matchesSearch(item, 'JABO')).toBe(true);
    expect(matchesSearch(item, 'nope')).toBe(false);
  });
});

describe('slugifyCogsKey', () => {
  it('lowercases and collapses non-alphanumerics to single underscores', () => {
    expect(slugifyCogsKey('Air EV')).toBe('air_ev');
    expect(slugifyCogsKey('M6 / Cloud')).toBe('m6_cloud');
    expect(slugifyCogsKey('Binguo / Neta')).toBe('binguo_neta');
    expect(slugifyCogsKey('  Denza  ')).toBe('denza');
  });
});

describe('currentPeriodWib', () => {
  it('buckets by the Asia/Jakarta local date (UTC+7)', () => {
    // 2026-07-31 18:00 UTC = 2026-08-01 01:00 WIB → August
    expect(currentPeriodWib(new Date('2026-07-31T18:00:00Z'))).toEqual({ month: 8, year: 2026 });
    // 2026-12-31 17:30 UTC = 2027-01-01 00:30 WIB → January next year
    expect(currentPeriodWib(new Date('2026-12-31T17:30:00Z'))).toEqual({ month: 1, year: 2027 });
    expect(currentPeriodWib(new Date('2026-07-12T05:00:00Z'))).toEqual({ month: 7, year: 2026 });
  });
});
