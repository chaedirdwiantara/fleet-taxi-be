const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // Excel serial day 0
const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Gojek sheets carry "d/m/Y H:i:s" or "d/m/Y" (Jakarta-local, per legacy
 * "Date & Time(JKT)" header). Returns YYYY-MM-DD or null.
 */
export function parseGojekDate(raw: unknown): string | null {
  if (raw instanceof Date) return toIsoDate(raw);
  if (typeof raw === 'number') return excelSerialToIsoDate(raw);
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const datePart = raw.trim().split(' ')[0]!;
  const dmy = datePart.split('/');
  if (dmy.length !== 3) return null;
  const [d, m, y] = dmy;
  const day = Number(d);
  const month = Number(m);
  const year = Number(y);
  if (!day || !month || !year || month > 12 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Grab sheets carry either an Excel serial number, a Date cell, or a
 * date-ish string (legacy used strtotime). Returns YYYY-MM-DD or null.
 */
export function parseGrabDate(raw: unknown): string | null {
  if (raw instanceof Date) return toIsoDate(raw);
  if (typeof raw === 'number') return excelSerialToIsoDate(raw);
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const s = raw.trim();
  // ISO-like first (unambiguous), then d/m/Y like legacy sheets
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.split(' ')[0]!.split('/');
  if (dmy.length === 3) {
    const [d, m, y] = dmy;
    if (Number(y) > 999 && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${Number(y)}-${pad(Number(m))}-${pad(Number(d))}`;
    }
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : toIsoDate(new Date(t));
}

export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  return toIsoDate(new Date(EXCEL_EPOCH_MS + serial * DAY_MS));
}

function toIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
