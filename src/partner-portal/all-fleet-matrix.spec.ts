import { describe, expect, it } from 'vitest';
import {
  buildAllFleetMatrix,
  type AllFleetGojekDay,
  type AllFleetInputRow,
  type BuildAllFleetInput,
} from './all-fleet-matrix';
import type { RentalDailyIncomeDto } from '../partner-rentals/rental-presenter';

function gojek(overrides: Partial<AllFleetInputRow> = {}): AllFleetInputRow {
  return {
    key: 'B1AAA',
    label: 'B1AAA',
    sublabel: 'Denza',
    days: { 1: 400_000, 2: 500_000 },
    zeroDays: [],
    history: [{ label: 'BUDI' }],
    ...overrides,
  };
}

function grab(overrides: Partial<AllFleetInputRow> = {}): AllFleetInputRow {
  return {
    key: 'B1AAA',
    label: 'B1AAA',
    sublabel: 'Denza',
    days: { 2: 200_000 },
    zeroDays: [],
    history: [{ label: 'BUDI', sublabel: 'Jakarta' }],
    ...overrides,
  };
}

function rental(overrides: Partial<RentalDailyIncomeDto> = {}): RentalDailyIncomeDto {
  return {
    plateNorm: 'B1AAA',
    plateNumber: 'B 1 AAA',
    vehicleType: 'Denza',
    region: 'Jakarta',
    days: { 3: 650_000 },
    total: 650_000,
    ...overrides,
  };
}

function input(overrides: Partial<BuildAllFleetInput> = {}): BuildAllFleetInput {
  return { mode: 'plate', daysInMonth: 31, gojek: [], grab: [], rental: [], ...overrides };
}

describe('buildAllFleetMatrix — plate mode', () => {
  it('merges the three sources into one row per plate, per day and in total', () => {
    const matrix = buildAllFleetMatrix(
      input({ gojek: [gojek()], grab: [grab()], rental: [rental()] }),
    );

    expect(matrix.rows).toHaveLength(1);
    const [row] = matrix.rows;
    expect(row.key).toBe('B1AAA');
    expect(row.days[1]).toMatchObject({ gojek: 400_000, grab: 0, rental: 0, total: 400_000 });
    expect(row.days[2]).toMatchObject({ gojek: 500_000, grab: 200_000, total: 700_000 });
    expect(row.days[3]).toMatchObject({ rental: 650_000, total: 650_000 });
    expect(row.totals).toEqual({
      gojek: 900_000,
      grab: 200_000,
      rental: 650_000,
      total: 1_750_000,
    });
  });

  it('lists the drivers of the plate as history, earliest day first', () => {
    const matrix = buildAllFleetMatrix(
      input({
        gojek: [
          gojek({ days: { 5: 100_000 }, history: [{ label: 'ASEP' }] }),
          gojek({ days: { 1: 100_000 }, history: [{ label: 'BUDI' }] }),
        ],
      }),
    );

    expect(matrix.rows[0].history).toEqual([
      { label: 'BUDI', sublabel: null, fromDay: 1, toDay: 1 },
      { label: 'ASEP', sublabel: null, fromDay: 5, toDay: 5 },
    ]);
  });

  it('merges several Grab composite rows of one plate into a single row', () => {
    const matrix = buildAllFleetMatrix(
      input({
        grab: [
          grab({ days: { 1: 100_000 }, history: [{ label: 'BUDI', sublabel: 'Jakarta' }] }),
          grab({ days: { 2: 300_000 }, history: [{ label: 'ASEP', sublabel: 'Bandung' }] }),
        ],
      }),
    );

    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0].totals.grab).toBe(400_000);
    expect(matrix.rows[0].history.map((h) => h.label)).toEqual(['BUDI', 'ASEP']);
  });

  it('reports the plate + region as the row sublabel', () => {
    const matrix = buildAllFleetMatrix(input({ rental: [rental()] }));
    expect(matrix.rows[0].sublabel).toBe('Denza · Jakarta');
    expect(matrix.rows[0].label).toBe('B 1 AAA');
  });

  it('sorts by total desc and counts subjects vs earners', () => {
    const matrix = buildAllFleetMatrix(
      input({
        gojek: [
          gojek({ key: 'B1AAA', label: 'B1AAA', days: { 1: 100_000 } }),
          gojek({ key: 'B2BBB', label: 'B2BBB', days: { 1: 900_000 } }),
          gojek({ key: 'B3CCC', label: 'B3CCC', days: {}, zeroDays: [4] }),
        ],
      }),
    );

    expect(matrix.rows.map((r) => r.key)).toEqual(['B2BBB', 'B1AAA', 'B3CCC']);
    expect(matrix.subjectCount).toBe(3);
    expect(matrix.activeCount).toBe(2);
    // present in the data, earned nothing → pink cell, not an empty one
    expect(matrix.rows[2].days[4]).toMatchObject({ total: 0, isZero: true });
  });

  it('never marks a day with money as zero', () => {
    const matrix = buildAllFleetMatrix(
      input({ gojek: [gojek({ days: { 5: 300_000 }, zeroDays: [5] })] }),
    );
    expect(matrix.rows[0].days[5]).toMatchObject({ total: 300_000, isZero: false });
  });

  it('drops days outside the month (dirty import data) from cells but keeps totals honest', () => {
    const matrix = buildAllFleetMatrix(
      input({ daysInMonth: 30, gojek: [gojek({ days: { 30: 100_000, 31: 999_000 } })] }),
    );
    expect(Object.keys(matrix.rows[0].days)).toEqual(['30']);
    expect(matrix.rows[0].totals.gojek).toBe(100_000);
  });

  it('sends unplated income to the "Tanpa plat" residual row', () => {
    const matrix = buildAllFleetMatrix(
      input({ gojek: [gojek({ key: '', label: '', days: { 1: 250_000 } })] }),
    );

    expect(matrix.rows).toHaveLength(0);
    expect(matrix.residual?.label).toBe('Tanpa plat');
    expect(matrix.residual?.totals.total).toBe(250_000);
    expect(matrix.totals.total).toBe(250_000);
  });

  it('has no residual row when everything is attributable', () => {
    expect(buildAllFleetMatrix(input({ gojek: [gojek()] })).residual).toBeNull();
  });
});

describe('buildAllFleetMatrix — Gojek per-day status', () => {
  const facts = (over: Partial<AllFleetGojekDay> = {}): AllFleetGojekDay => ({
    displayAmount: 400_000,
    countedAmount: 400_000,
    dailyTarget: 388_000,
    exception: null,
    ...over,
  });

  it('carries the Gojek verdict onto the day it belongs to', () => {
    const matrix = buildAllFleetMatrix(
      input({
        gojek: [gojek({ gojekDays: { 1: facts(), 2: facts({ countedAmount: 500_000 }) } })],
      }),
    );

    expect(matrix.rows[0].days[1].gojekDay).toMatchObject({ countedAmount: 400_000 });
    expect(matrix.rows[0].days[2].gojekDay?.dailyTarget).toBe(388_000);
  });

  it('opens a cell for a day that has status but no money (bebas setoran)', () => {
    const matrix = buildAllFleetMatrix(
      input({
        gojek: [
          gojek({
            days: {},
            gojekDays: {
              9: facts({
                displayAmount: 0,
                countedAmount: 0,
                exception: { isBebasSetoran: true, keterangan: 'Disewa' },
              }),
            },
          }),
        ],
      }),
    );

    expect(matrix.rows[0].days[9]).toMatchObject({ total: 0, isZero: false });
    expect(matrix.rows[0].days[9].gojekDay?.exception?.isBebasSetoran).toBe(true);
  });

  it('adds not a single rupiah anywhere — status is presentation, never money', () => {
    const withStatus = buildAllFleetMatrix(
      input({
        gojek: [
          gojek({
            gojekDays: {
              1: facts(),
              // a display-only Manual Payment and an exception day: both carry a
              // display amount the matrix must keep ignoring
              5: facts({
                displayAmount: 300_000,
                countedAmount: 0,
                hasDisplayOnlyManualPayment: true,
              }),
              9: facts({
                displayAmount: 0,
                countedAmount: 0,
                exception: { isBebasSetoran: true, keterangan: null },
              }),
            },
          }),
        ],
        grab: [grab()],
        rental: [rental()],
      }),
    );
    const without = buildAllFleetMatrix(
      input({ gojek: [gojek()], grab: [grab()], rental: [rental()] }),
    );

    expect(withStatus.totals).toEqual(without.totals);
    expect(withStatus.rows[0].totals).toEqual(without.rows[0].totals);
    expect(withStatus.dailyTotals[1]).toMatchObject(without.dailyTotals[1]);
    expect(withStatus.dailyTotals[5]).toMatchObject({ gojek: 0, total: 0 });
  });

  it('leaves the residual row without a verdict — it pools many subjects', () => {
    const matrix = buildAllFleetMatrix(
      input({
        gojek: [gojek({ key: '', label: '', days: { 1: 250_000 }, gojekDays: { 1: facts() } })],
      }),
    );

    expect(matrix.residual?.days[1].total).toBe(250_000);
    expect(matrix.residual?.days[1].gojekDay).toBeUndefined();
  });
});

describe('buildAllFleetMatrix — driver mode', () => {
  const driverInput = input({
    mode: 'driver',
    gojek: [
      gojek({
        key: 'drv:BUDI',
        label: 'BUDI',
        sublabel: null,
        history: [{ label: 'B1AAA' }, { label: 'B2BBB' }],
      }),
    ],
    grab: [
      grab({
        key: 'drv:BUDI',
        label: 'BUDI',
        sublabel: null,
        history: [{ label: 'B1AAA', sublabel: 'Jakarta' }],
      }),
    ],
    rental: [rental()],
  });

  it('groups by person and lists the plates driven as history', () => {
    const matrix = buildAllFleetMatrix(driverInput);

    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0].key).toBe('drv:BUDI');
    expect(matrix.rows[0].history.map((h) => h.label)).toEqual(['B1AAA', 'B2BBB']);
    // Grab contributes the city as the plate's sublabel
    expect(matrix.rows[0].history.find((h) => h.label === 'B1AAA')?.sublabel).toBe('Jakarta');
  });

  it('parks all rental omset in the "Tanpa driver" row — Rental has no driver', () => {
    const matrix = buildAllFleetMatrix(driverInput);

    expect(matrix.rows[0].totals.rental).toBe(0);
    expect(matrix.residual?.label).toBe('Tanpa driver');
    expect(matrix.residual?.totals.rental).toBe(650_000);
  });

  it('keeps the same grand total as plate mode — identical rows, different grouping', () => {
    const plateTotals = buildAllFleetMatrix({ ...driverInput, mode: 'plate' }).totals;
    const driverTotals = buildAllFleetMatrix(driverInput).totals;

    expect(driverTotals).toEqual(plateTotals);
    expect(driverTotals.total).toBe(900_000 + 200_000 + 650_000);
  });

  it('daily totals include the residual row', () => {
    const matrix = buildAllFleetMatrix(driverInput);

    expect(matrix.dailyTotals[3]).toMatchObject({ rental: 650_000, total: 650_000 });
    expect(matrix.dailyTotals[2]).toMatchObject({ gojek: 500_000, grab: 200_000 });
  });

  it('collects nameless import rows in the residual row', () => {
    const matrix = buildAllFleetMatrix(
      input({
        mode: 'driver',
        gojek: [gojek({ key: 'drv:', label: '', days: { 7: 120_000 } })],
      }),
    );

    expect(matrix.rows).toHaveLength(0);
    expect(matrix.residual?.totals.gojek).toBe(120_000);
  });
});
