import { describe, expect, it } from 'vitest';
import {
  driverLabelFromKey,
  driverRowKey,
  isDriverMode,
  parseMonitoringMode,
} from './monitoring-mode';

describe('parseMonitoringMode', () => {
  it('accepts driver', () => {
    expect(parseMonitoringMode('driver')).toBe('driver');
  });

  it.each([undefined, null, '', 'plate', 'PLATE', 'Driver', 'nonsense'])(
    'falls back to plate for %p',
    (raw) => {
      expect(parseMonitoringMode(raw)).toBe('plate');
    },
  );

  it('isDriverMode mirrors the parsed value', () => {
    expect(isDriverMode(parseMonitoringMode('driver'))).toBe(true);
    expect(isDriverMode(parseMonitoringMode('plate'))).toBe(false);
  });
});

describe('driverRowKey', () => {
  it('uses the shared driver identity (upper, collapsed whitespace)', () => {
    expect(driverRowKey('  budi   santoso ')).toBe('drv:BUDI SANTOSO');
  });

  it('collapses spelling-equal names onto one key', () => {
    expect(driverRowKey('Budi Santoso')).toBe(driverRowKey('BUDI  SANTOSO'));
  });

  it('keeps nameless rows in one explicit bucket', () => {
    expect(driverRowKey('')).toBe('drv:');
    expect(driverRowKey(null)).toBe('drv:');
  });

  it('can never collide with a normalized plate', () => {
    expect(driverRowKey('B1234XYZ')).not.toBe('B1234XYZ');
  });

  it('round-trips through driverLabelFromKey', () => {
    expect(driverLabelFromKey(driverRowKey('Budi Santoso'))).toBe('BUDI SANTOSO');
    expect(driverLabelFromKey(driverRowKey(''))).toBe('');
  });
});
