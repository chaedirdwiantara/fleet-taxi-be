import { describe, expect, it } from 'vitest';
import { encodeDueSegments } from './due-segments';

describe('encodeDueSegments (legacy due_segments RLE)', () => {
  it('returns no segments when the month has no due rows', () => {
    expect(encodeDueSegments({})).toEqual([]);
  });

  it('collapses a constant target into one segment', () => {
    expect(encodeDueSegments({ 1: 388000, 2: 388000, 3: 388000 })).toEqual([
      { amount: 388000, fromDay: 1, toDay: 3 },
    ]);
  });

  it('splits when the target changes mid-month (408.000 (1) / 388.000 (2–16))', () => {
    const dailyDue: Record<number, number> = { 1: 408000 };
    for (let d = 2; d <= 16; d++) dailyDue[d] = 388000;
    expect(encodeDueSegments(dailyDue)).toEqual([
      { amount: 408000, fromDay: 1, toDay: 1 },
      { amount: 388000, fromDay: 2, toDay: 16 },
    ]);
  });

  it('does not split a run on a day gap (legacy: only value changes split)', () => {
    expect(encodeDueSegments({ 2: 388000, 16: 388000 })).toEqual([
      { amount: 388000, fromDay: 2, toDay: 16 },
    ]);
  });

  it('starts a new segment when an old value reappears', () => {
    expect(encodeDueSegments({ 1: 388000, 2: 408000, 3: 388000 })).toEqual([
      { amount: 388000, fromDay: 1, toDay: 1 },
      { amount: 408000, fromDay: 2, toDay: 2 },
      { amount: 388000, fromDay: 3, toDay: 3 },
    ]);
  });

  it('walks days in ascending numeric order regardless of key insertion order', () => {
    expect(encodeDueSegments({ 10: 388000, 2: 388000, 21: 408000 })).toEqual([
      { amount: 388000, fromDay: 2, toDay: 10 },
      { amount: 408000, fromDay: 21, toDay: 21 },
    ]);
  });
});
