/**
 * Invoice model for one rental transaction — the customer-facing document.
 *
 * Pure and database-free so the numbering, line-item and terbilang rules are
 * unit-testable. Money is integer rupiah (PROJECT-BRIEF.md §7): this module
 * only *arranges* amounts already computed by `rental-presenter`, it never
 * derives new ones beyond summing the lines it lays out.
 *
 * COGS and nett profit are deliberately absent — they are the partner's
 * internal margin, never shown to the customer being billed.
 */
import { RentalItemDto } from './rental-presenter';

export interface InvoiceLine {
  description: string;
  /** Secondary line under the description (period, cost note, …). */
  detail: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
}

export interface RentalInvoiceDto {
  invoiceNumber: string;
  /** ISO instant the document was rendered. */
  issuedAt: string;
  issuer: { name: string; code: string };
  customer: { name: string; phone: string | null };
  rental: {
    plateNumber: string;
    vehicleType: string | null;
    rentalType: string | null;
    serviceArea: string | null;
    region: string | null;
    startDate: string;
    endDate: string;
    days: number;
  };
  lines: InvoiceLine[];
  subtotal: number;
  total: number;
  /** Security deposit held for the unit; informational, never netted off the total. */
  deposit: number;
  amountInWords: string;
  payment: {
    status: string;
    proofCount: number;
    /** Newest evidence upload — the de-facto settlement timestamp. Null if none. */
    settledAt: string | null;
  };
}

/**
 * `INV/2026/08/00042` — year/month of the rental start plus the zero-padded
 * rental id. Stable for a given rental, so re-downloading yields the same
 * number, and unique because the id is.
 */
export function invoiceNumber(item: Pick<RentalItemDto, 'id' | 'startDate'>): string {
  const [year, month] = item.startDate.split('-');
  return `INV/${year}/${month}/${String(item.id).padStart(5, '0')}`;
}

/** `INV/2026/08/00042` → `invoice-2026-08-00042.pdf` (filesystem-safe). */
export function invoiceFileName(number: string): string {
  return `invoice${number.replace(/^INV/i, '').replace(/\//g, '-')}.pdf`;
}

/**
 * Billable lines: the rental itself (days × price/day) plus the additional
 * cost when the transaction carries one. `additionalCost` is a per-transaction
 * TOTAL, hence quantity 1.
 */
export function invoiceLines(item: RentalItemDto): InvoiceLine[] {
  const lines: InvoiceLine[] = [
    {
      description: `Sewa Kendaraan ${item.plateNumber}`,
      detail: [item.vehicleType, item.rentalType].filter(Boolean).join(' · ') || null,
      quantity: item.days,
      unit: 'hari',
      unitPrice: item.pricePerDay,
      amount: item.gross,
    },
  ];
  if (item.additionalCost > 0) {
    lines.push({
      description: 'Biaya Tambahan',
      detail: item.additionalCostDescription,
      quantity: 1,
      unit: 'paket',
      unitPrice: item.additionalCost,
      amount: item.additionalCost,
    });
  }
  return lines;
}

const ONES = [
  '',
  'satu',
  'dua',
  'tiga',
  'empat',
  'lima',
  'enam',
  'tujuh',
  'delapan',
  'sembilan',
  'sepuluh',
  'sebelas',
];
const SCALES: Array<[number, string]> = [
  [1_000_000_000_000, 'triliun'],
  [1_000_000_000, 'miliar'],
  [1_000_000, 'juta'],
  [1_000, 'ribu'],
];

/**
 * Indonesian amount-in-words, the "Terbilang" line every local invoice
 * carries. Handles the irregular forms: 11..19 → "belas", 100 → "seratus",
 * 1.000 → "seribu".
 */
export function terbilang(amount: number): string {
  if (!Number.isFinite(amount)) return 'nol';
  const n = Math.trunc(Math.abs(amount));
  const words = spell(n) || 'nol';
  return amount < 0 ? `minus ${words}` : words;
}

function spell(n: number): string {
  if (n < 12) return ONES[n]!;
  if (n < 20) return `${ONES[n - 10]} belas`;
  if (n < 100) {
    const rest = spell(n % 10);
    return `${ONES[Math.floor(n / 10)]} puluh${rest ? ` ${rest}` : ''}`;
  }
  if (n < 200) {
    const rest = spell(n - 100);
    return `seratus${rest ? ` ${rest}` : ''}`;
  }
  if (n < 1_000) {
    const rest = spell(n % 100);
    return `${ONES[Math.floor(n / 100)]} ratus${rest ? ` ${rest}` : ''}`;
  }
  if (n < 2_000) {
    const rest = spell(n - 1_000);
    return `seribu${rest ? ` ${rest}` : ''}`;
  }
  for (const [value, name] of SCALES) {
    if (n >= value) {
      const rest = spell(n % value);
      return `${spell(Math.floor(n / value))} ${name}${rest ? ` ${rest}` : ''}`;
    }
  }
  /* istanbul ignore next — unreachable: every n ≥ 1000 matches a scale above */
  return '';
}

/** Capitalize the first letter and append the currency suffix. */
export function amountInWords(amount: number): string {
  const words = terbilang(amount);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} rupiah`;
}

/**
 * Assemble the invoice for one *unclipped* rental (pass `presentRental(row)`
 * without a month, so the document always bills the full booked range).
 */
export function buildRentalInvoice(
  item: RentalItemDto,
  issuer: { name: string; code: string },
  issuedAt: Date,
): RentalInvoiceDto {
  const lines = invoiceLines(item);
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const uploaded = item.paymentProofs.filter((p) => p.status === 'uploaded');
  const settledAt = uploaded.reduce<string | null>(
    (latest, p) => (latest == null || p.uploadedAt > latest ? p.uploadedAt : latest),
    null,
  );

  return {
    invoiceNumber: invoiceNumber(item),
    issuedAt: issuedAt.toISOString(),
    issuer,
    customer: { name: item.customerName?.trim() || 'Pelanggan Umum', phone: item.customerPhone },
    rental: {
      plateNumber: item.plateNumber,
      vehicleType: item.vehicleType,
      rentalType: item.rentalType,
      serviceArea: item.serviceArea,
      region: item.region,
      startDate: item.startDate,
      endDate: item.endDate,
      days: item.days,
    },
    lines,
    subtotal,
    total: subtotal,
    deposit: item.deposit,
    amountInWords: amountInWords(subtotal),
    payment: {
      status: item.paymentStatus,
      proofCount: uploaded.length,
      settledAt,
    },
  };
}
