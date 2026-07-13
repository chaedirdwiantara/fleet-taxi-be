/**
 * Pure unit tests for the Debt Summary presenter — no database needed. The
 * merge/tagihan math must stay consistent with the fleet grid's outstanding:
 * tagihanSetoran = max(0, dailyTarget × activeDays − setoran terbayar).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDebtFilters,
  buildDebtRows,
  filterDebtRows,
  paginateDebtRows,
  sortDebtRows,
  type DebtQuery,
  type GojekPlateStat,
  type GrabDriverStat,
} from '../src/partner-portal/debt-presenter';

const gojekStat = (over: Partial<GojekPlateStat>): GojekPlateStat => ({
  plate: 'B1553RZB',
  driverName: 'IQBAL FAUZI',
  setoranPaid: 0,
  depositPaid: 0,
  activeDays: 0,
  totalDue: 0,
  dueCount: 0,
  lastDate: '2026-07-01',
  fleetTarget: 100_000,
  serviceArea: 'Jakarta',
  rentalPartner: 'Ahmad Aryawan',
  ...over,
});

const grabStat = (over: Partial<GrabDriverStat>): GrabDriverStat => ({
  plate: 'B1665ROW',
  driverName: 'ACHMAD FAUZI',
  phone: '6281234567890',
  city: 'Jakarta',
  lastDate: '2026-07-02',
  rentalPartner: 'Rekli Fonda',
  ...over,
});

const query = (over: Partial<DebtQuery> = {}): DebtQuery => ({
  sortBy: 'selisihDeposit',
  sortOrder: 'asc',
  ...over,
});

describe('buildDebtRows', () => {
  it('derives tagihan setoran from the fleet-target shortfall', () => {
    const rows = buildDebtRows(
      [gojekStat({ fleetTarget: 100_000, activeDays: 10, setoranPaid: 250_000 })],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tagihanSetoran).toBe(750_000);
    expect(rows[0]!.totalTagihan).toBe(750_000);
    expect(rows[0]!.selisihDeposit).toBe(-750_000);
  });

  it('never emits a negative tagihan when setoran overshoots the target', () => {
    const rows = buildDebtRows(
      [gojekStat({ fleetTarget: 100_000, activeDays: 2, setoranPaid: 900_000 })],
      [],
    );
    expect(rows[0]!.tagihanSetoran).toBe(0);
    expect(rows[0]!.selisihDeposit).toBe(0);
  });

  it('counts uncounted manual payments as deposit terbayar', () => {
    const rows = buildDebtRows(
      [gojekStat({ depositPaid: 1_000_000, activeDays: 5, fleetTarget: 100_000 })],
      [],
    );
    expect(rows[0]!.depositTerbayar).toBe(1_000_000);
    expect(rows[0]!.selisihDeposit).toBe(1_000_000 - 500_000);
  });

  it('merges the same driver across gojek plates and grab identity', () => {
    const rows = buildDebtRows(
      [
        gojekStat({ plate: 'B1111AAA', driverName: 'Budi Santoso', activeDays: 1 }),
        gojekStat({
          plate: 'B2222BBB',
          driverName: 'BUDI SANTOSO',
          activeDays: 1,
          lastDate: '2026-07-05',
          serviceArea: '',
        }),
      ],
      [grabStat({ driverName: 'budi santoso', plate: 'B3333CCC', lastDate: '2026-07-09' })],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.driverName).toBe('BUDI SANTOSO');
    expect(row.tagihanSetoran).toBe(200_000);
    expect(row.lastPlate).toBe('B3333CCC'); // most recent transaction wins
    expect(row.phone).toBe('6281234567890'); // grab enriches the contact
  });

  it('falls back to the plate when the import has no driver name', () => {
    const rows = buildDebtRows([gojekStat({ driverName: '', activeDays: 1 })], []);
    expect(rows[0]!.driverName).toBe('B1553RZB');
  });

  it('flags drivers absent from the freshest imported period as nonaktif', () => {
    const rows = buildDebtRows(
      [
        gojekStat({ driverName: 'LAMA', lastDate: '2026-05-20' }),
        gojekStat({ plate: 'B9999ZZZ', driverName: 'BARU', lastDate: '2026-07-03' }),
      ],
      [],
    );
    const byName = new Map(rows.map((r) => [r.driverName, r.status]));
    expect(byName.get('LAMA')).toBe('nonaktif');
    expect(byName.get('BARU')).toBe('aktif');
  });

  it('keeps cicilan lainnya as a null placeholder outside the total', () => {
    const rows = buildDebtRows([gojekStat({ activeDays: 1 })], []);
    expect(rows[0]!.cicilanLainnya).toBeNull();
    expect(rows[0]!.tagihanEtle).toBe(0);
    expect(rows[0]!.tagihanOwnRisk).toBe(0);
    expect(rows[0]!.totalTagihan).toBe(rows[0]!.tagihanSetoran);
  });
});

describe('filter / sort / paginate', () => {
  const rows = buildDebtRows(
    [
      gojekStat({ plate: 'B1111AAA', driverName: 'ANDI', activeDays: 3, serviceArea: 'Jakarta' }),
      gojekStat({
        plate: 'B2222BBB',
        driverName: 'CITRA',
        activeDays: 1,
        serviceArea: 'Bandung',
        rentalPartner: 'Rekli Fonda',
        lastDate: '2026-06-10',
      }),
    ],
    [grabStat({ driverName: 'BAYU', plate: 'B3333CCC' })],
  );

  it('builds dropdown options from the full set', () => {
    expect(buildDebtFilters(rows)).toEqual({
      cabang: ['Bandung', 'Jakarta'],
      koordinator: ['Ahmad Aryawan', 'Rekli Fonda'],
    });
  });

  it('filters by status, cabang and search', () => {
    expect(filterDebtRows(rows, query({ status: 'nonaktif' }))).toHaveLength(1);
    expect(filterDebtRows(rows, query({ cabang: 'Bandung' }))[0]!.driverName).toBe('CITRA');
    expect(filterDebtRows(rows, query({ search: 'b 3333' }))[0]!.driverName).toBe('BAYU');
    expect(filterDebtRows(rows, query({ search: 'andi' }))[0]!.driverName).toBe('ANDI');
  });

  it('sorts worst-covered first by default and paginates with a total', () => {
    const sorted = sortDebtRows(rows, query());
    expect(sorted[0]!.driverName).toBe('ANDI'); // largest uncovered tagihan
    const page = paginateDebtRows(sorted, 2, 2);
    expect(page.meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(page.data).toHaveLength(1);
  });
});
