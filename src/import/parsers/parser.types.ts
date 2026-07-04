/** Raw spreadsheet row: cell values in column order. */
export type RawRow = unknown[];

export interface ParsedGojekRow {
  transactionDate: string; // YYYY-MM-DD
  driverId: string | null;
  driverName: string | null;
  vehiclePlate: string | null;
  vehiclePlateNorm: string;
  amount: number; // integer rupiah
  type: string | null;
  isManualPaymentSetoran: number | null; // 1 when type contains "Manual Payment" (legacy default), else null
  referenceId: string | null;
}

export interface ParsedGrabRow {
  date: string; // YYYY-MM-DD
  plateNumber: string;
  plateNumberNorm: string;
  city: string | null;
  carModel: string | null;
  driverName: string;
  driverPhoneNumber: string | null;
  tiering: string | null;
  partnerName: string | null;
  totalOnlineHours: string;
  totalBookings: number;
  totalRides: number;
  cancelByDriver: number;
  fullfilmentRate: string;
  driverCancellationRate: string;
  driverFare: number;
  tollAndOthers: number;
  totalIncentive: number;
  totalEarningCollected: number;
  compositeKey: string; // plate|city|driver (brief §5; legacy used md5)
}

/**
 * Streaming row mapper: feed rows top-to-bottom; rows before the header are
 * ignored; after the header each row maps to a detail row or null (skip).
 */
export interface RowMapper<T> {
  headerFound: boolean;
  feed(row: RawRow): T | null;
}

export function cellString(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function isEmptyRow(row: RawRow): boolean {
  return row.every(
    (c) => (typeof c !== 'string' && typeof c !== 'number') || String(c).trim() === '',
  );
}
