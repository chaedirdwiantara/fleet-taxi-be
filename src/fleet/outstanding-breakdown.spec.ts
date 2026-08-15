import { describe, expect, it } from 'vitest';
import {
  buildOutstandingBreakdown,
  NO_DRIVER_LABEL,
  NO_PLATE_LABEL,
  type OutstandingSlice,
} from './outstanding-breakdown';

const slice = (s: Partial<OutstandingSlice> & Pick<OutstandingSlice, 'partKey' | 'ym'>) => ({
  firstDate: `${s.ym}-01`,
  lastDate: `${s.ym}-28`,
  due: 0,
  paid: 0,
  ...s,
});

describe('buildOutstandingBreakdown', () => {
  it('is empty when the subject has no history at all', () => {
    expect(buildOutstandingBreakdown([], 'plate')).toEqual({
      parts: [],
      months: [],
      total: 0,
      contributorCount: 0,
      rangeFrom: null,
      rangeTo: null,
    });
  });

  it('folds slices into contributors and months whose closing balance is the total', () => {
    const result = buildOutstandingBreakdown(
      [
        slice({ partKey: 'BUDI', ym: '2026-05', due: 1000, paid: 800, firstDate: '2026-05-03' }),
        slice({ partKey: 'BUDI', ym: '2026-06', due: 2000, paid: 2000, lastDate: '2026-06-30' }),
        slice({ partKey: 'SITI', ym: '2026-06', due: 500, paid: 100, firstDate: '2026-06-10' }),
      ],
      'plate',
    );

    // per contributor: their whole span, oldest first row first
    expect(result.parts).toEqual([
      { label: 'BUDI', due: 3000, paid: 2800, delta: 200, from: '2026-05-03', to: '2026-06-30' },
      { label: 'SITI', due: 500, paid: 100, delta: 400, from: '2026-06-10', to: '2026-06-28' },
    ]);
    // per month: both contributors merged, with the running balance
    expect(result.months).toEqual([
      { ym: '2026-05', due: 1000, paid: 800, delta: 200, balance: 200 },
      { ym: '2026-06', due: 2500, paid: 2100, delta: 400, balance: 600 },
    ]);
    // the two views are two readings of the same money
    expect(result.total).toBe(600);
    expect(result.parts.reduce((sum, p) => sum + p.delta, 0)).toBe(result.total);
    expect(result.contributorCount).toBe(2);
    expect(result.rangeFrom).toBe('2026-05');
    expect(result.rangeTo).toBe('2026-06');
  });

  it('counts only contributors that left a remainder, and drops moneyless ones', () => {
    const result = buildOutstandingBreakdown(
      [
        slice({ partKey: 'LUNAS', ym: '2026-05', due: 900, paid: 900 }),
        slice({ partKey: 'KOSONG', ym: '2026-05' }), // handover day, no money either way
        slice({ partKey: 'KURANG', ym: '2026-05', due: 900, paid: 400 }),
      ],
      'plate',
    );

    expect(result.parts.map((p) => p.label)).toEqual(['LUNAS', 'KURANG']);
    expect(result.contributorCount).toBe(1);
    expect(result.total).toBe(500);
  });

  it('reports the span of months that MOVED the balance, not every month seen', () => {
    const result = buildOutstandingBreakdown(
      [
        slice({ partKey: 'BUDI', ym: '2026-04', due: 500, paid: 500 }), // settled
        slice({ partKey: 'BUDI', ym: '2026-05', due: 500, paid: 300 }), // moves
        slice({ partKey: 'BUDI', ym: '2026-06', due: 500, paid: 500 }), // settled
      ],
      'plate',
    );

    expect(result.months).toHaveLength(3);
    expect(result.rangeFrom).toBe('2026-05');
    expect(result.rangeTo).toBe('2026-05');
  });

  it('keeps a credit balance negative instead of clamping it', () => {
    const result = buildOutstandingBreakdown(
      [slice({ partKey: 'BUDI', ym: '2026-05', due: 300, paid: 800 })],
      'plate',
    );

    expect(result.total).toBe(-500);
    expect(result.parts[0]!.delta).toBe(-500);
  });

  it('labels the anonymous contributor after the grid mode', () => {
    expect(
      buildOutstandingBreakdown([slice({ partKey: '', ym: '2026-05', due: 100 })], 'plate')
        .parts[0]!.label,
    ).toBe(NO_DRIVER_LABEL);
    expect(
      buildOutstandingBreakdown([slice({ partKey: '', ym: '2026-05', due: 100 })], 'driver')
        .parts[0]!.label,
    ).toBe(NO_PLATE_LABEL);
  });
});
