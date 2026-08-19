import { describe, expect, it } from 'vitest';
import { byteCompare, compareVehicleType } from './sort';

describe('byteCompare (legacy strcmp port)', () => {
  it('orders by byte value, uppercase before lowercase', () => {
    expect(byteCompare('A', 'B')).toBeLessThan(0);
    expect(byteCompare('B', 'A')).toBeGreaterThan(0);
    expect(byteCompare('A', 'A')).toBe(0);
    expect(byteCompare('Z', 'a')).toBeLessThan(0);
  });
});

describe('compareVehicleType (monitoring row order)', () => {
  const sorted = (types: (string | null)[]) => [...types].sort(compareVehicleType);

  it('orders A→Z', () => {
    expect(sorted(['WULING CLOUD', 'BYD M6', 'Toyota Avanza'])).toEqual([
      'BYD M6',
      'Toyota Avanza',
      'WULING CLOUD',
    ]);
  });

  it('treats one model typed in different cases as one block', () => {
    expect(compareVehicleType('BYD M6', 'byd m6')).toBe(0);
    // ...so the whole block stays together instead of splitting around Toyota
    expect(sorted(['byd m6', 'Toyota Avanza', 'BYD M6'])).toEqual([
      'byd m6',
      'BYD M6',
      'Toyota Avanza',
    ]);
  });

  it('reads trailing numbers as numbers, not as text', () => {
    expect(sorted(['BYD ATTO 10', 'BYD ATTO 2'])).toEqual(['BYD ATTO 2', 'BYD ATTO 10']);
  });

  it('ignores surrounding whitespace', () => {
    expect(compareVehicleType('  BYD M6 ', 'BYD M6')).toBe(0);
  });

  it('sends untyped plates to the bottom, never to the top', () => {
    expect(sorted(['WULING CLOUD', null, 'BYD M6', '', '   '])).toEqual([
      'BYD M6',
      'WULING CLOUD',
      null,
      '',
      '   ',
    ]);
    expect(compareVehicleType(null, '')).toBe(0);
  });
});
