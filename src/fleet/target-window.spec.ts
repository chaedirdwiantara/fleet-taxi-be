import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_TARGET } from './gojek-grid.types';
import { billedWindow, dailyTargetFrom } from './target-window';

describe('dailyTargetFrom', () => {
  it('lets an explicit fleet_targets override win over the observed dues', () => {
    expect(dailyTargetFrom({ 1: 500_000, 2: 500_000 }, 388_000)).toBe(388_000);
  });

  it('takes the most frequent daily due, not their mean', () => {
    // The mean would be 458_333 — a rate nobody was ever charged.
    expect(dailyTargetFrom({ 3: 500_000, 4: 450_000, 5: 450_000 }, 0)).toBe(450_000);
  });

  it('breaks a tie toward the later day, so a new rate wins over the one it replaced', () => {
    expect(dailyTargetFrom({ 3: 500_000, 4: 450_000 }, 0)).toBe(450_000);
    // …and order of insertion must not matter.
    expect(dailyTargetFrom({ 4: 450_000, 3: 500_000 }, 0)).toBe(450_000);
  });

  it('falls back to the constant when there is nothing to infer from', () => {
    expect(dailyTargetFrom({}, 0)).toBe(DEFAULT_DAILY_TARGET);
    expect(dailyTargetFrom({ 1: 0 }, 0)).toBe(DEFAULT_DAILY_TARGET);
    expect(dailyTargetFrom({}, -1)).toBe(DEFAULT_DAILY_TARGET);
  });
});

describe('billedWindow', () => {
  const NONE = new Set<number>();

  it('reports the span of the days that carry a due row', () => {
    expect(billedWindow({ 21: 423_000, 22: 423_000, 23: 423_000, 24: 423_000 }, NONE)).toEqual({
      billedDays: 4,
      billFromDay: 21,
      billToDay: 24,
    });
  });

  it('counts a gap in the middle as unbilled without breaking the span', () => {
    expect(billedWindow({ 21: 423_000, 23: 423_000, 24: 423_000 }, NONE)).toEqual({
      billedDays: 3,
      billFromDay: 21,
      billToDay: 24,
    });
  });

  it('drops bebas-setoran days, including at the edges of the span', () => {
    const dailyDue = { 10: 400_000, 11: 400_000, 12: 400_000 };
    expect(billedWindow(dailyDue, new Set([11]))).toEqual({
      billedDays: 2,
      billFromDay: 10,
      billToDay: 12,
    });
    expect(billedWindow(dailyDue, new Set([10, 12]))).toEqual({
      billedDays: 1,
      billFromDay: 11,
      billToDay: 11,
    });
  });

  it('reports nothing billed when every day is waived or empty', () => {
    expect(billedWindow({}, NONE)).toEqual({
      billedDays: 0,
      billFromDay: null,
      billToDay: null,
    });
    expect(billedWindow({ 5: 400_000 }, new Set([5]))).toEqual({
      billedDays: 0,
      billFromDay: null,
      billToDay: null,
    });
    expect(billedWindow({ 5: 0 }, NONE)).toEqual({
      billedDays: 0,
      billFromDay: null,
      billToDay: null,
    });
  });

  it('never reports a span that runs backwards', () => {
    const { billFromDay, billToDay } = billedWindow({ 30: 1, 2: 1, 17: 1 }, NONE);
    expect(billFromDay).toBe(2);
    expect(billToDay).toBe(30);
    expect(billFromDay!).toBeLessThanOrEqual(billToDay!);
  });
});
