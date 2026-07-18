export interface DueSegment {
  amount: number;
  fromDay: number;
  toDay: number;
}

/**
 * Run-length encode a vehicle's per-day due amounts into contiguous
 * equal-amount segments, walking days ascending (legacy due_segments). The
 * target can change mid-month; the Setoran column then lists every value with
 * its active range, e.g. 408.000 (1) / 388.000 (2–16). Only days that actually
 * have a due row participate: a day gap doesn't split a run.
 */
export function encodeDueSegments(dailyDue: Record<number, number>): DueSegment[] {
  const days = Object.keys(dailyDue)
    .map(Number)
    .sort((a, b) => a - b);
  const segments: DueSegment[] = [];
  for (const day of days) {
    const amount = dailyDue[day]!; // keys came from dailyDue itself
    const last = segments[segments.length - 1];
    if (last && last.amount === amount) last.toDay = day;
    else segments.push({ amount, fromDay: day, toDay: day });
  }
  return segments;
}
