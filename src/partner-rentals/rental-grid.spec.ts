import { describe, expect, it } from 'vitest';
import { rentals } from '../db/schema';
import { buildRentalGrid, type RegisteredPlateInput } from './rental-grid';
import { presentRental } from './rental-presenter';

type RentalRow = typeof rentals.$inferSelect;

function row(overrides: Partial<RentalRow> = {}): RentalRow {
  return {
    id: 1,
    partnerId: 10,
    plateNumber: 'B 1793 SCP',
    plateNumberNorm: 'B1793SCP',
    vehicleType: 'Air EV',
    region: 'Jakarta',
    startDate: '2026-07-02',
    endDate: '2026-07-04',
    pricePerDay: 450_000,
    cogsPerDay: 300_000,
    cogsType: 'Air EV',
    additionalCost: 0,
    additionalCostDescription: null,
    deposit: 0,
    rentalType: 'Lepas Kunci',
    infoSource: null,
    serviceArea: null,
    customerName: 'Budi',
    customerPhone: null,
    paymentStatus: 'Belum Dibayar',
    ppnRateBps: 0,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

const plate = (over: Partial<RegisteredPlateInput> = {}): RegisteredPlateInput => ({
  plateNumber: 'B 1793 SCP',
  plateNumberNorm: 'B1793SCP',
  vehicleType: 'Air EV',
  ...over,
});

const JULY = { month: 7, year: 2026 };

describe('buildRentalGrid', () => {
  it('spreads a booking over the days it covers, and only those', () => {
    const grid = buildRentalGrid([row()], [plate()], JULY);

    expect(grid.daysInMonth).toBe(31);
    expect(Object.keys(grid.rows[0]!.days).map(Number)).toEqual([2, 3, 4]);
    expect(grid.rows[0]!.days[2]).toEqual({
      amount: 450_000,
      paymentStatus: 'Belum Dibayar',
      rentalId: 1,
    });
    expect(grid.rows[0]!.totals.rentedDays).toBe(3);
  });

  it('charges the per-transaction additional cost once, on the first covered day', () => {
    const grid = buildRentalGrid([row({ additionalCost: 200_000 })], [plate()], JULY);

    expect(grid.rows[0]!.days[2]!.amount).toBe(650_000);
    expect(grid.rows[0]!.days[3]!.amount).toBe(450_000);
  });

  it("agrees with Rental Management: sum of the days IS the booking's omset", () => {
    const booking = row({ startDate: '2026-06-28', endDate: '2026-07-03', additionalCost: 75_000 });
    const grid = buildRentalGrid([booking], [plate()], JULY);

    const summed = Object.values(grid.rows[0]!.days).reduce((n, cell) => n + cell.amount, 0);
    expect(summed).toBe(presentRental(booking, JULY).omset);
    expect(grid.rows[0]!.totals.omset).toBe(summed);
  });

  it('clips a cross-month booking to the selected month', () => {
    const grid = buildRentalGrid(
      [row({ startDate: '2026-06-28', endDate: '2026-07-02' })],
      [plate()],
      JULY,
    );

    expect(Object.keys(grid.rows[0]!.days).map(Number)).toEqual([1, 2]);
    expect(grid.rows[0]!.bookings[0]).toMatchObject({
      displayStartDate: '2026-07-01',
      displayEndDate: '2026-07-02',
      days: 2,
    });
  });

  it('drops a booking that misses the month entirely', () => {
    const grid = buildRentalGrid(
      [row({ startDate: '2026-08-01', endDate: '2026-08-05' })],
      [plate()],
      JULY,
    );

    expect(grid.rows[0]!.bookings).toEqual([]);
    expect(grid.rows[0]!.totals).toEqual({ omset: 0, cogs: 0, nett: 0, rentedDays: 0 });
    expect(grid.activeCount).toBe(0);
  });

  it('keeps an idle registered plate as a row — that is what utilisation means', () => {
    const grid = buildRentalGrid(
      [row()],
      [plate(), plate({ plateNumberNorm: 'B9ZZZ', plateNumber: 'B 9 ZZZ', vehicleType: null })],
      JULY,
    );

    expect(grid.plateCount).toBe(2);
    expect(grid.activeCount).toBe(1);
    expect(grid.rows.at(-1)).toMatchObject({ plateNorm: 'B9ZZZ', days: {}, bookings: [] });
  });

  it('shows a rental booked on a plate that was never registered', () => {
    const grid = buildRentalGrid(
      [row({ plateNumber: 'B 5 XYZ', plateNumberNorm: 'B5XYZ' })],
      [],
      JULY,
    );

    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]!.plateNorm).toBe('B5XYZ');
  });

  it('carries the payment status of the booking that owns the day', () => {
    const grid = buildRentalGrid(
      [
        row({
          id: 1,
          startDate: '2026-07-01',
          endDate: '2026-07-02',
          paymentStatus: 'Sudah Dibayar',
        }),
        row({ id: 2, startDate: '2026-07-05', endDate: '2026-07-06' }),
      ],
      [plate()],
      JULY,
    );

    expect(grid.rows[0]!.days[1]).toMatchObject({ paymentStatus: 'Sudah Dibayar', rentalId: 1 });
    expect(grid.rows[0]!.days[5]).toMatchObject({ paymentStatus: 'Belum Dibayar', rentalId: 2 });
  });

  it('counts a day once when two bookings somehow share it, and calls it unpaid', () => {
    const grid = buildRentalGrid(
      [
        row({
          id: 1,
          startDate: '2026-07-01',
          endDate: '2026-07-03',
          paymentStatus: 'Sudah Dibayar',
        }),
        row({ id: 2, startDate: '2026-07-03', endDate: '2026-07-04' }),
      ],
      [plate()],
      JULY,
    );

    expect(grid.rows[0]!.totals.rentedDays).toBe(4);
    expect(grid.rows[0]!.days[3]).toMatchObject({
      amount: 900_000,
      paymentStatus: 'Belum Dibayar',
    });
  });

  it('totals per day and per month across every plate, biggest earner first', () => {
    const grid = buildRentalGrid(
      [
        row({ id: 1 }),
        row({
          id: 2,
          plateNumber: 'B 2 AAA',
          plateNumberNorm: 'B2AAA',
          startDate: '2026-07-02',
          endDate: '2026-07-02',
          pricePerDay: 1_000_000,
          cogsPerDay: 400_000,
        }),
      ],
      [plate()],
      JULY,
    );

    expect(grid.rows.map((r) => r.plateNorm)).toEqual(['B1793SCP', 'B2AAA']);
    expect(grid.dailyTotals[2]).toBe(450_000 + 1_000_000);
    expect(grid.dailyTotals[3]).toBe(450_000);
    expect(grid.totals).toEqual({
      omset: 450_000 * 3 + 1_000_000,
      cogs: 300_000 * 3 + 400_000,
      nett: 450_000 * 3 - 300_000 * 3 + (1_000_000 - 400_000),
      rentedDays: 4,
    });
  });

  it('reports omset and nett WITHOUT PPN — VAT is held for the state', () => {
    const grid = buildRentalGrid([row({ ppnRateBps: 1100 })], [plate()], JULY);

    expect(grid.totals.omset).toBe(450_000 * 3);
    expect(grid.totals.nett).toBe((450_000 - 300_000) * 3);
  });

  it('lists a plate metadata from its most recent booking', () => {
    const grid = buildRentalGrid(
      [
        row({ id: 1, startDate: '2026-07-01', endDate: '2026-07-02', region: 'Bandung' }),
        row({ id: 2, startDate: '2026-07-10', endDate: '2026-07-11', region: 'Surabaya' }),
      ],
      [],
      JULY,
    );

    expect(grid.rows[0]!.region).toBe('Surabaya');
  });
});
