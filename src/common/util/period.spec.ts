import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MAX_RANGE_DAYS, daysInRange, parseDateRange, splitRangeByMonth } from './period';

describe('parseDateRange', () => {
  it('returns undefined when neither bound is sent (whole-period semantics)', () => {
    expect(parseDateRange(undefined, undefined)).toBeUndefined();
    expect(parseDateRange('', '')).toBeUndefined();
  });

  it('accepts a well-formed pair', () => {
    expect(parseDateRange('2026-07-01', '2026-07-15')).toEqual({
      from: '2026-07-01',
      to: '2026-07-15',
    });
  });

  it('accepts a single day (both bounds equal)', () => {
    expect(parseDateRange('2026-07-15', '2026-07-15')).toEqual({
      from: '2026-07-15',
      to: '2026-07-15',
    });
  });

  it('rejects a half-specified range', () => {
    expect(() => parseDateRange('2026-07-01', undefined)).toThrow(BadRequestException);
    expect(() => parseDateRange(undefined, '2026-07-01')).toThrow(BadRequestException);
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => parseDateRange('01-07-2026', '2026-07-15')).toThrow(BadRequestException);
    expect(() => parseDateRange('2026-7-1', '2026-07-15')).toThrow(BadRequestException);
    expect(() => parseDateRange('2026-02-30', '2026-03-01')).toThrow(BadRequestException);
  });

  it('rejects an inverted range', () => {
    expect(() => parseDateRange('2026-07-15', '2026-07-01')).toThrow(BadRequestException);
  });

  it(`rejects a span longer than ${MAX_RANGE_DAYS} days but accepts exactly that`, () => {
    // 2026-07-01 + 91 days = 2026-09-30 -> 92 days inclusive
    expect(parseDateRange('2026-07-01', '2026-09-30')).toEqual({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(() => parseDateRange('2026-07-01', '2026-10-01')).toThrow(BadRequestException);
  });
});

describe('daysInRange', () => {
  it('counts both ends', () => {
    expect(daysInRange({ from: '2026-07-01', to: '2026-07-01' })).toBe(1);
    expect(daysInRange({ from: '2026-07-01', to: '2026-07-31' })).toBe(31);
  });

  it('spans month and year boundaries', () => {
    expect(daysInRange({ from: '2026-07-25', to: '2026-08-05' })).toBe(12);
    expect(daysInRange({ from: '2026-12-30', to: '2027-01-02' })).toBe(4);
  });
});

describe('splitRangeByMonth', () => {
  it('keeps a within-month range as one slice', () => {
    expect(splitRangeByMonth({ from: '2026-07-04', to: '2026-07-20' })).toEqual([
      { year: 2026, month: 7, fromDay: 4, toDay: 20 },
    ]);
  });

  it('cuts a cross-month range at the month boundary', () => {
    expect(splitRangeByMonth({ from: '2026-07-25', to: '2026-08-05' })).toEqual([
      { year: 2026, month: 7, fromDay: 25, toDay: 31 },
      { year: 2026, month: 8, fromDay: 1, toDay: 5 },
    ]);
  });

  it('fills whole months in the middle and crosses the year boundary', () => {
    expect(splitRangeByMonth({ from: '2026-12-20', to: '2027-02-03' })).toEqual([
      { year: 2026, month: 12, fromDay: 20, toDay: 31 },
      { year: 2027, month: 1, fromDay: 1, toDay: 31 },
      { year: 2027, month: 2, fromDay: 1, toDay: 3 },
    ]);
  });

  it('respects a short February', () => {
    expect(splitRangeByMonth({ from: '2026-02-01', to: '2026-03-01' })).toEqual([
      { year: 2026, month: 2, fromDay: 1, toDay: 28 },
      { year: 2026, month: 3, fromDay: 1, toDay: 1 },
    ]);
  });

  it('covers exactly the days of the range', () => {
    const range = { from: '2026-07-25', to: '2026-09-03' };
    const covered = splitRangeByMonth(range).reduce((n, s) => n + s.toDay - s.fromDay + 1, 0);
    expect(covered).toBe(daysInRange(range));
  });
});
