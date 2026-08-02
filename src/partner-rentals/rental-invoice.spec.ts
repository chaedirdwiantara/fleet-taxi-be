import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  buildRentalInvoice,
  invoiceFileName,
  invoiceLines,
  invoiceNumber,
  terbilang,
} from './rental-invoice';
import { presentRental } from './rental-presenter';

const ISSUER = { name: 'Jayana Giri Sentosa', code: 'JGS', npwp: null };
const ISSUED_AT = new Date('2026-08-02T03:00:00.000Z');

type RentalRow = Parameters<typeof presentRental>[0];

function row(overrides: Partial<RentalRow> = {}): RentalRow {
  return {
    id: 42,
    partnerId: 1,
    plateNumber: 'B 1234 XYZ',
    plateNumberNorm: 'B1234XYZ',
    vehicleType: 'Air EV',
    region: 'Jakarta',
    startDate: '2026-08-01',
    endDate: '2026-08-05',
    pricePerDay: 350_000,
    cogsPerDay: 120_000,
    cogsType: 'Air EV',
    additionalCost: 0,
    additionalCostDescription: null,
    deposit: 0,
    rentalType: 'Dengan Driver',
    infoSource: null,
    serviceArea: 'Jakarta Selatan',
    customerName: 'Andi Wijaya',
    customerPhone: '0812-3456-7890',
    paymentStatus: 'Sudah Dibayar',
    ppnRateBps: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

const proof = (id: number, uploadedAt: string, status = 'uploaded') => ({
  id,
  fileName: `bukti-${id}.jpg`,
  contentType: 'image/jpeg',
  sizeBytes: 1024,
  status,
  uploadedByName: 'Sri Rahayu',
  uploadedByEmail: 'sri@example.test',
  uploadedAt,
});

describe('invoiceNumber / invoiceFileName', () => {
  it('derives a stable number from the rental start month and id', () => {
    expect(invoiceNumber({ id: 42, startDate: '2026-08-01' })).toBe('INV/2026/08/00042');
  });

  it('keeps ids beyond the padding width intact', () => {
    expect(invoiceNumber({ id: 1234567, startDate: '2026-01-31' })).toBe('INV/2026/01/1234567');
  });

  it('turns the number into a filesystem-safe file name', () => {
    expect(invoiceFileName('INV/2026/08/00042')).toBe('invoice-2026-08-00042.pdf');
  });
});

describe('invoiceLines', () => {
  it('bills days × price/day as a single line when there is no extra cost', () => {
    const lines = invoiceLines(presentRental(row()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      description: 'Sewa Kendaraan B 1234 XYZ',
      detail: 'Air EV · Dengan Driver',
      quantity: 5,
      unit: 'hari',
      unitPrice: 350_000,
      amount: 1_750_000,
    });
  });

  it('adds the additional cost as one per-transaction line', () => {
    const lines = invoiceLines(
      presentRental(row({ additionalCost: 250_000, additionalCostDescription: 'Tol & parkir' })),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      description: 'Biaya Tambahan',
      detail: 'Tol & parkir',
      quantity: 1,
      amount: 250_000,
    });
  });

  it('omits the additional-cost line when it is zero', () => {
    expect(invoiceLines(presentRental(row({ additionalCost: 0 })))).toHaveLength(1);
  });
});

describe('terbilang', () => {
  it.each([
    [0, 'nol'],
    [1, 'satu'],
    [11, 'sebelas'],
    [17, 'tujuh belas'],
    [20, 'dua puluh'],
    [21, 'dua puluh satu'],
    [100, 'seratus'],
    [101, 'seratus satu'],
    [250, 'dua ratus lima puluh'],
    [1_000, 'seribu'],
    [1_500, 'seribu lima ratus'],
    [2_000, 'dua ribu'],
    [1_750_000, 'satu juta tujuh ratus lima puluh ribu'],
    [2_000_000_000, 'dua miliar'],
    [1_000_000_000_000, 'satu triliun'],
  ])('spells %i', (amount, expected) => {
    expect(terbilang(amount)).toBe(expected);
  });

  it('prefixes negatives', () => {
    expect(terbilang(-5_000)).toBe('minus lima ribu');
  });

  it('capitalizes and suffixes the currency for the document line', () => {
    expect(amountInWords(1_750_000)).toBe('Satu juta tujuh ratus lima puluh ribu rupiah');
  });
});

describe('buildRentalInvoice', () => {
  it('bills the FULL booked range even when the item was clipped elsewhere', () => {
    // A rental spanning Jul 28 → Aug 5 is 5 days *inside August*, 9 in total.
    const full = presentRental(row({ startDate: '2026-07-28' }));
    const invoice = buildRentalInvoice(full, ISSUER, ISSUED_AT);
    expect(invoice.rental.days).toBe(9);
    expect(invoice.total).toBe(9 * 350_000);
  });

  it('totals the lines and never nets the deposit off the bill', () => {
    const item = presentRental(
      row({ additionalCost: 250_000, additionalCostDescription: 'Tol', deposit: 500_000 }),
    );
    const invoice = buildRentalInvoice(item, ISSUER, ISSUED_AT);
    expect(invoice.subtotal).toBe(2_000_000);
    expect(invoice.total).toBe(2_000_000);
    expect(invoice.deposit).toBe(500_000);
    expect(invoice.amountInWords).toBe('Dua juta rupiah');
  });

  it('never leaks the partner margin (COGS / nett profit) into the document', () => {
    const invoice = buildRentalInvoice(presentRental(row()), ISSUER, ISSUED_AT);
    expect(JSON.stringify(invoice)).not.toContain('120000');
    expect(Object.keys(invoice)).not.toContain('nettProfit');
  });

  it('counts only uploaded evidence and settles at the newest upload', () => {
    const item = presentRental(row(), undefined, [
      proof(1, '2026-08-01T02:00:00.000Z'),
      proof(2, '2026-08-01T09:30:00.000Z'),
      proof(3, '2026-08-02T00:00:00.000Z', 'pending'),
    ]);
    const invoice = buildRentalInvoice(item, ISSUER, ISSUED_AT);
    expect(invoice.payment).toEqual({
      status: 'Sudah Dibayar',
      proofCount: 2,
      settledAt: '2026-08-01T09:30:00.000Z',
    });
  });

  it('falls back to a generic customer label when none was recorded', () => {
    const invoice = buildRentalInvoice(
      presentRental(row({ customerName: '  ', customerPhone: null })),
      ISSUER,
      ISSUED_AT,
    );
    expect(invoice.customer).toEqual({ name: 'Pelanggan Umum', phone: null });
  });
});

describe('PPN on the invoice', () => {
  const PKP = { name: 'Jayana Giri Sentosa', code: 'JGS', npwp: '01.234.567.8-901.000' };

  it('charges 11% on sewa PLUS biaya tambahan, never on the deposit', () => {
    const item = presentRental(
      row({ additionalCost: 275_000, deposit: 500_000, ppnRateBps: 1100 }),
    );
    const invoice = buildRentalInvoice(item, PKP, ISSUED_AT);

    // 5 hari × 350.000 = 1.750.000, + 275.000 tambahan = DPP 2.025.000
    expect(invoice.subtotal).toBe(2_025_000);
    expect(invoice.ppnAmount).toBe(222_750); // 11% of the DPP, deposit excluded
    expect(invoice.total).toBe(2_247_750);
    expect(invoice.deposit).toBe(500_000);
  });

  it('spells the amount in words AFTER tax — that is what is owed', () => {
    const invoice = buildRentalInvoice(presentRental(row({ ppnRateBps: 1100 })), PKP, ISSUED_AT);
    expect(invoice.total).toBe(1_942_500); // 1.750.000 + 192.500
    expect(invoice.amountInWords).toBe(
      'Satu juta sembilan ratus empat puluh dua ribu lima ratus rupiah',
    );
  });

  it('stays untaxed for a non-PKP issuer', () => {
    const invoice = buildRentalInvoice(presentRental(row({ ppnRateBps: 0 })), ISSUER, ISSUED_AT);
    expect(invoice.ppnAmount).toBe(0);
    expect(invoice.total).toBe(invoice.subtotal);
  });

  it('rounds to whole rupiah — no cents ever reach the document', () => {
    // 3 hari × 333.333 = 999.999 → 11% = 109.999,89
    const item = presentRental(
      row({ pricePerDay: 333_333, endDate: '2026-08-03', ppnRateBps: 1100 }),
    );
    const invoice = buildRentalInvoice(item, PKP, ISSUED_AT);
    expect(invoice.subtotal).toBe(999_999);
    expect(invoice.ppnAmount).toBe(110_000);
    expect(Number.isInteger(invoice.total)).toBe(true);
  });

  it('prints the issuer NPWP so the document is usable for tax records', () => {
    const invoice = buildRentalInvoice(presentRental(row({ ppnRateBps: 1100 })), PKP, ISSUED_AT);
    expect(invoice.issuer.npwp).toBe('01.234.567.8-901.000');
  });
});
