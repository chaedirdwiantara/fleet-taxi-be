import { describe, expect, it } from 'vitest';
import { GojekRowMapper } from './gojek.parser';
import { GrabRowMapper } from './grab.parser';

const GOJEK_HEADER = [
  'Date & Time(JKT)',
  'Driver ID',
  'Driver Name',
  'Phone',
  'Vehicle',
  'Amount',
  'Total Outstanding Balance',
  'Type',
  'GoPay Transaction Reference ID',
];

describe('GojekRowMapper (ported from legacy postImport)', () => {
  it('ignores rows before the header, then maps by header positions', () => {
    const mapper = new GojekRowMapper();
    expect(mapper.feed(['Laporan', '', ''])).toBeNull();
    expect(mapper.feed(GOJEK_HEADER)).toBeNull();
    expect(mapper.headerFound).toBe(true);

    const row = mapper.feed([
      '04/07/2026 10:11:12',
      'D-1',
      'Budi',
      '0812',
      'b 1234 xy',
      'Rp 488,000',
      '0',
      'Deduction',
      'REF-123',
    ]);
    expect(row).toEqual({
      transactionDate: '2026-07-04',
      driverId: 'D-1',
      driverName: 'Budi',
      vehiclePlate: 'b 1234 xy',
      vehiclePlateNorm: 'B1234XY',
      amount: 488000,
      type: 'Deduction',
      isManualPaymentSetoran: null,
      referenceId: 'REF-123',
    });
  });

  it('flags Manual Payment rows (legacy isManualPaymentType)', () => {
    const mapper = new GojekRowMapper();
    mapper.feed(GOJEK_HEADER);
    const row = mapper.feed([
      '05/07/2026',
      'D-1',
      'Budi',
      '',
      'B1234XY',
      '100000',
      '',
      'Manual Payment',
      '',
    ]);
    expect(row?.isManualPaymentSetoran).toBe(1);
    expect(row?.type).toBe('Manual Payment');
  });

  it('skips empty and dateless rows', () => {
    const mapper = new GojekRowMapper();
    mapper.feed(GOJEK_HEADER);
    expect(mapper.feed(['', '', '', '', '', '', '', '', ''])).toBeNull();
    expect(mapper.feed([null, 'D-1', 'Budi', '', 'B1', '100', '', 'due', ''])).toBeNull();
  });
});

describe('GrabRowMapper', () => {
  it('maps by header and builds plate|city|driver composite key', () => {
    const mapper = new GrabRowMapper();
    mapper.feed([
      'Date',
      'Plate Number',
      'City',
      'Car Model',
      'Driver Name',
      'Tiering',
      'Partner Name',
      'Driver Phone Number',
      'Total Online Hours',
      'Total Bookings',
      'Total Rides',
      'Cancel by Driver',
      'Fullfilment Rate',
      'Driver Cancellation Rate',
      'Driver Fare (IDR)',
      'Toll and Others (IDR)',
      'Total Incentive (IDR)',
      'Total Earning Collected (IDR)',
    ]);
    expect(mapper.headerFound).toBe(true);

    const row = mapper.feed([
      '2026-07-04',
      'B 5678 ZZ',
      'Jakarta',
      'Avanza',
      'Siti',
      'Gold',
      'PT X',
      '0813',
      '8.5',
      '12',
      '11',
      '1',
      '91.7',
      '8.3',
      'Rp 350,000',
      '15,000',
      '50,000',
      'Rp 415,000',
    ]);
    expect(row?.date).toBe('2026-07-04');
    expect(row?.plateNumberNorm).toBe('B5678ZZ');
    expect(row?.compositeKey).toBe('B5678ZZ|Jakarta|Siti');
    expect(row?.totalEarningCollected).toBe(415000);
    expect(row?.totalOnlineHours).toBe('8.50');
    expect(row?.totalBookings).toBe(12);
  });
});
