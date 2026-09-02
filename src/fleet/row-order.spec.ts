import { describe, expect, it } from 'vitest';
import { compareGojekRows, type OrderableRow } from './row-order';

const row = (over: Partial<OrderableRow> = {}): OrderableRow => ({
  isExited: false,
  rentalPartner: 'BHISA',
  vehicleType: 'BYD M6',
  driverName: 'BUDI',
  ...over,
});

const order = (rows: OrderableRow[], opts?: Parameters<typeof compareGojekRows>[2]) =>
  [...rows].sort((a, b) => compareGojekRows(a, b, opts)).map((r) => r.driverName);

describe('compareGojekRows', () => {
  it('sinks every exited subject below every active one, whatever the other keys say', () => {
    // The exited row wins on partner, type AND name — it must still land last.
    const rows = [
      row({ isExited: true, rentalPartner: 'AAA', vehicleType: 'AAA', driverName: 'AAA' }),
      row({ driverName: 'ZZZ', rentalPartner: 'ZZZ', vehicleType: 'ZZZ' }),
    ];
    expect(order(rows, { groupByRentalPartner: true })).toEqual(['ZZZ', 'AAA']);
  });

  it('keeps the reading order inside each block: partner, then type, then name', () => {
    const rows = [
      row({ rentalPartner: 'BHISA', vehicleType: 'Wuling', driverName: 'CITRA' }),
      row({ rentalPartner: 'ALPHA', vehicleType: 'Wuling', driverName: 'ANDI' }),
      row({ rentalPartner: 'BHISA', vehicleType: 'BYD M6', driverName: 'DEWI' }),
      row({ rentalPartner: 'BHISA', vehicleType: 'BYD M6', driverName: 'BAMBANG' }),
    ];
    expect(order(rows, { groupByRentalPartner: true })).toEqual([
      'ANDI', // ALPHA first
      'BAMBANG', // BHISA · BYD M6 · B…
      'DEWI', // BHISA · BYD M6 · D…
      'CITRA', // BHISA · Wuling
    ]);
  });

  it('ignores Rental Partner on the partner portal, which has no such column', () => {
    const rows = [
      row({ rentalPartner: 'ZZZ', driverName: 'ANDI' }),
      row({ rentalPartner: 'AAA', driverName: 'BUDI' }),
    ];
    expect(order(rows)).toEqual(['ANDI', 'BUDI']);
    expect(order(rows, { groupByRentalPartner: true })).toEqual(['BUDI', 'ANDI']);
  });

  it('skips the Type key in driver mode — a person is not one vehicle model', () => {
    const rows = [
      row({ vehicleType: 'Wuling', driverName: 'ANDI' }),
      row({ vehicleType: 'BYD M6', driverName: 'BUDI' }),
    ];
    expect(order(rows, { byDriver: true })).toEqual(['ANDI', 'BUDI']); // by name only
    expect(order(rows)).toEqual(['BUDI', 'ANDI']); // plate mode: BYD before Wuling
  });

  it('still groups exited rows by partner among themselves', () => {
    const rows = [
      row({ isExited: true, rentalPartner: 'ZZZ', driverName: 'ANDI' }),
      row({ isExited: true, rentalPartner: 'AAA', driverName: 'BUDI' }),
      row({ driverName: 'CITRA' }),
    ];
    expect(order(rows, { groupByRentalPartner: true })).toEqual(['CITRA', 'BUDI', 'ANDI']);
  });
});
