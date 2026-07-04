import { describe, expect, it } from 'vitest';
import { parseGojekDate, parseGrabDate } from './dates';
import { cleanMoney, normalizePlate } from './plate';

describe('normalizePlate (legacy preg_replace port)', () => {
  it('uppercases and strips non-alphanumerics', () => {
    expect(normalizePlate('b 1234 xy')).toBe('B1234XY');
    expect(normalizePlate('B-1234-XY')).toBe('B1234XY');
    expect(normalizePlate('  b 1234•xy ')).toBe('B1234XY');
    expect(normalizePlate(null)).toBe('');
  });
});

describe('cleanMoney (legacy cleanNumber port, rounded to rupiah)', () => {
  it('strips Rp, spaces, commas and rounds', () => {
    expect(cleanMoney('Rp 488,000')).toBe(488000);
    expect(cleanMoney('1,234,567.89')).toBe(1234568);
    expect(cleanMoney(488000.4)).toBe(488000);
    expect(cleanMoney('')).toBe(0);
    expect(cleanMoney(null)).toBe(0);
    expect(cleanMoney('n/a')).toBe(0);
  });
});

describe('date parsing', () => {
  it('parses Gojek d/m/Y with and without time', () => {
    expect(parseGojekDate('04/07/2026 10:00:00')).toBe('2026-07-04');
    expect(parseGojekDate('4/7/2026')).toBe('2026-07-04');
    expect(parseGojekDate('')).toBeNull();
    expect(parseGojekDate('not a date')).toBeNull();
  });

  it('parses Grab excel serials, ISO strings and d/m/Y', () => {
    expect(parseGrabDate(45843)).toBe('2025-07-05'); // excel serial
    expect(parseGrabDate('2026-07-04')).toBe('2026-07-04');
    expect(parseGrabDate('04/07/2026')).toBe('2026-07-04');
    expect(parseGrabDate(new Date(Date.UTC(2026, 6, 4)))).toBe('2026-07-04');
    expect(parseGrabDate(null)).toBeNull();
  });
});
