import { describe, expect, it } from 'vitest';
import {
  decideSchedule,
  defaultRange,
  InvalidRangeError,
  isValidRunAt,
  nextScheduledAt,
  splitByMonth,
  utcBounds,
  validateRange,
  wibClock,
} from './sync-schedule';

describe('wibClock', () => {
  it('shifts UTC to Asia/Jakarta (+7, no DST)', () => {
    expect(wibClock(new Date('2026-09-12T17:30:00Z'))).toEqual({
      date: '2026-09-13',
      time: '00:30',
    });
    expect(wibClock(new Date('2026-09-13T16:59:59Z'))).toEqual({
      date: '2026-09-13',
      time: '23:59',
    });
  });
});

describe('decideSchedule', () => {
  it('waits until the configured time', () => {
    expect(decideSchedule('04:30', '05:00', [])).toEqual({
      due: false,
      reason: 'Belum jam 05:00 WIB.',
    });
    expect(decideSchedule('05:00', '05:00', []).due).toBe(true);
    expect(decideSchedule('23:30', '05:00', [])).toEqual({ due: true, reason: 'Jadwal harian.' });
  });

  it('runs once per day — never again after a success', () => {
    expect(decideSchedule('06:00', '05:00', ['failed', 'success']).due).toBe(false);
    expect(decideSchedule('06:00', '05:00', ['success']).reason).toBe('Sudah berhasil hari ini.');
  });

  it('does not start while another scheduled run is still running', () => {
    expect(decideSchedule('06:00', '05:00', ['running']).reason).toBe(
      'Masih ada proses yang berjalan.',
    );
  });

  it('retries a failure on later ticks, at most 3 attempts per day', () => {
    expect(decideSchedule('05:30', '05:00', ['failed'])).toEqual({
      due: true,
      reason: 'Percobaan ulang ke-2.',
    });
    expect(decideSchedule('06:00', '05:00', ['failed', 'failed']).due).toBe(true);
    expect(decideSchedule('06:30', '05:00', ['failed', 'failed', 'failed'])).toEqual({
      due: false,
      reason: 'Batas 3 percobaan hari ini tercapai.',
    });
  });
});

describe('nextScheduledAt', () => {
  const runAt = '05:00';
  it('today when the time has not passed yet', () => {
    // 03:00 WIB on 2026-09-13 = 2026-09-12T20:00Z
    const next = nextScheduledAt(new Date('2026-09-12T20:00:00Z'), runAt, false);
    expect(next.toISOString()).toBe('2026-09-12T22:00:00.000Z'); // 05:00 WIB same day
  });
  it('tomorrow once past the time or already done today', () => {
    expect(nextScheduledAt(new Date('2026-09-13T01:00:00Z'), runAt, false).toISOString()).toBe(
      '2026-09-13T22:00:00.000Z',
    );
    expect(nextScheduledAt(new Date('2026-09-12T20:00:00Z'), runAt, true).toISOString()).toBe(
      '2026-09-13T22:00:00.000Z',
    );
  });
});

describe('defaultRange', () => {
  // 2026-09-13 00:30 WIB
  const now = new Date('2026-09-12T17:30:00Z');
  it('is yesterday (WIB) for lookback 1 — today is never pulled', () => {
    expect(defaultRange(1, now)).toEqual({ dateFrom: '2026-09-12', dateTo: '2026-09-12' });
  });
  it('goes back lookback days and clamps to 1..7', () => {
    expect(defaultRange(3, now)).toEqual({ dateFrom: '2026-09-10', dateTo: '2026-09-12' });
    expect(defaultRange(0, now)).toEqual(defaultRange(1, now));
    expect(defaultRange(99, now)).toEqual({ dateFrom: '2026-09-06', dateTo: '2026-09-12' });
  });
});

describe('validateRange', () => {
  const now = new Date('2026-09-13T05:00:00Z'); // 12:00 WIB 2026-09-13
  it('accepts an ordered range up to 31 days ending today', () => {
    expect(validateRange('2026-08-14', '2026-09-13', now)).toEqual({
      dateFrom: '2026-08-14',
      dateTo: '2026-09-13',
    });
  });
  it.each([
    ['2026-9-1', '2026-09-02', /tidak valid/],
    ['2026-02-30', '2026-03-01', /tidak valid/],
    ['2026-09-05', '2026-09-01', /awal tidak boleh melewati/],
    ['2026-09-13', '2026-09-14', /melewati hari ini/],
    ['2026-08-13', '2026-09-13', /maksimal 31 hari/],
  ])('rejects %s..%s', (from, to, msg) => {
    expect(() => validateRange(from, to, now)).toThrow(InvalidRangeError);
    expect(() => validateRange(from, to, now)).toThrow(msg);
  });
});

describe('utcBounds', () => {
  it('maps a WIB day to the portal UTC window (D-1 17:00:00.000Z .. D 16:59:59.999Z)', () => {
    const { fromUtc, toUtc } = utcBounds({ dateFrom: '2026-09-08', dateTo: '2026-09-08' });
    expect(fromUtc.toISOString()).toBe('2026-09-07T17:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-09-08T16:59:59.999Z');
  });
  it('spans multi-day ranges', () => {
    const { fromUtc, toUtc } = utcBounds({ dateFrom: '2026-08-30', dateTo: '2026-09-02' });
    expect(fromUtc.toISOString()).toBe('2026-08-29T17:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-09-02T16:59:59.999Z');
  });
});

describe('splitByMonth', () => {
  it('keeps a single-month range as one slice', () => {
    expect(splitByMonth({ dateFrom: '2026-09-01', dateTo: '2026-09-07' })).toEqual([
      { year: 2026, month: 9, dateFrom: '2026-09-01', dateTo: '2026-09-07' },
    ]);
  });
  it('splits a range that straddles months into one slice per period', () => {
    expect(splitByMonth({ dateFrom: '2026-08-30', dateTo: '2026-09-02' })).toEqual([
      { year: 2026, month: 8, dateFrom: '2026-08-30', dateTo: '2026-08-31' },
      { year: 2026, month: 9, dateFrom: '2026-09-01', dateTo: '2026-09-02' },
    ]);
    expect(splitByMonth({ dateFrom: '2025-12-31', dateTo: '2026-01-01' })).toEqual([
      { year: 2025, month: 12, dateFrom: '2025-12-31', dateTo: '2025-12-31' },
      { year: 2026, month: 1, dateFrom: '2026-01-01', dateTo: '2026-01-01' },
    ]);
  });
});

describe('isValidRunAt', () => {
  it('accepts HH:00 / HH:30 only', () => {
    expect(isValidRunAt('05:00')).toBe(true);
    expect(isValidRunAt('23:30')).toBe(true);
    expect(isValidRunAt('05:15')).toBe(false);
    expect(isValidRunAt('24:00')).toBe(false);
    expect(isValidRunAt('5:00')).toBe(false);
  });
});
