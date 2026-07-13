/**
 * Presentation layer for the partner-portal Debt Summary. PURE: the service
 * feeds per-plate aggregates already scoped to the partner's registered
 * plates; everything here (driver merge, tagihan math, filter/sort/paginate)
 * is deterministic and unit-testable without a database.
 *
 * Column mapping — every figure is derived LIVE from the same import data the
 * Gojek/Grab fleet-monitoring screens read (no separate debt table):
 * - depositTerbayar  = all-time Gojek manual payments flagged "Tidak Masuk
 *                      Setoran" (the only non-setoran payment bucket in the data)
 * - tagihanSetoran   = all-time setoran shortfall per plate:
 *                      max(0, dailyTarget × activeDays − setoran terbayar) —
 *                      the same math behind the fleet grid's `outstanding`
 * - tagihanEtle / tagihanOwnRisk = no source data yet → always 0 (R1)
 * - cicilanLainnya   = placeholder column, logic lands later → always null
 * - selisihDeposit   = depositTerbayar − totalTagihan; negative means the
 *                      deposit does not cover the outstanding bill
 */
import { DEFAULT_DAILY_TARGET } from '../fleet/gojek-grid.types';

// ---- service → presenter inputs ---------------------------------------------

/** All-time Gojek aggregates for one plate, target already resolved. */
export interface GojekPlateStat {
  plate: string;
  driverName: string;
  setoranPaid: number;
  depositPaid: number;
  activeDays: number;
  totalDue: number;
  dueCount: number;
  lastDate: string; // 'YYYY-MM-DD'
  fleetTarget: number;
  serviceArea: string;
  rentalPartner: string;
}

/** Latest Grab appearance of one plate+driver pair. */
export interface GrabDriverStat {
  plate: string;
  driverName: string;
  phone: string | null;
  city: string;
  lastDate: string; // 'YYYY-MM-DD'
  rentalPartner: string;
}

// ---- API DTOs ----------------------------------------------------------------

export type DriverStatus = 'aktif' | 'nonaktif';

export interface DebtRowDto {
  driverName: string;
  cabang: string;
  koordinator: string;
  lastPlate: string;
  phone: string | null;
  status: DriverStatus;
  depositTerbayar: number;
  tagihanSetoran: number;
  tagihanEtle: number;
  tagihanOwnRisk: number;
  cicilanLainnya: number | null;
  totalTagihan: number;
  selisihDeposit: number;
}

export interface DebtFiltersDto {
  cabang: string[];
  koordinator: string[];
}

export const DEBT_SORT_FIELDS = [
  'driverName',
  'cabang',
  'koordinator',
  'depositTerbayar',
  'tagihanSetoran',
  'totalTagihan',
  'selisihDeposit',
] as const;
export type DebtSortField = (typeof DEBT_SORT_FIELDS)[number];

export interface DebtQuery {
  status?: DriverStatus;
  cabang?: string;
  koordinator?: string;
  search?: string;
  sortBy: DebtSortField;
  sortOrder: 'asc' | 'desc';
}

const EMPTY_LABEL = '-';

/** Latest 'YYYY-MM' across both platforms — the freshest imported period. */
function latestPeriod(gojek: GojekPlateStat[], grab: GrabDriverStat[]): string {
  let max = '';
  for (const s of gojek) if (s.lastDate.slice(0, 7) > max) max = s.lastDate.slice(0, 7);
  for (const s of grab) if (s.lastDate.slice(0, 7) > max) max = s.lastDate.slice(0, 7);
  return max;
}

/** Same fallback chain the fleet grid uses to price a day of setoran. */
function resolveDailyTarget(s: GojekPlateStat): number {
  if (s.fleetTarget > 0) return s.fleetTarget;
  if (s.dueCount > 0) {
    const avg = Math.round(s.totalDue / s.dueCount);
    if (avg > 0) return avg;
  }
  return DEFAULT_DAILY_TARGET;
}

interface DriverAccumulator {
  driverName: string;
  cabang: string;
  koordinator: string;
  lastPlate: string;
  lastDate: string;
  phone: string | null;
  depositTerbayar: number;
  tagihanSetoran: number;
}

/**
 * Merges per-plate Gojek/Grab aggregates into one row per driver. Drivers are
 * keyed by uppercased name; plate-only Gojek rows (no driver on the import)
 * fall back to the plate itself so no money silently disappears.
 */
export function buildDebtRows(gojek: GojekPlateStat[], grab: GrabDriverStat[]): DebtRowDto[] {
  const period = latestPeriod(gojek, grab);
  const byDriver = new Map<string, DriverAccumulator>();

  const upsert = (name: string, plate: string): DriverAccumulator => {
    const key = name.trim().toUpperCase() || plate;
    let acc = byDriver.get(key);
    if (!acc) {
      acc = {
        driverName: key,
        cabang: '',
        koordinator: '',
        lastPlate: '',
        lastDate: '',
        phone: null,
        depositTerbayar: 0,
        tagihanSetoran: 0,
      };
      byDriver.set(key, acc);
    }
    return acc;
  };

  for (const s of gojek) {
    const acc = upsert(s.driverName, s.plate);
    acc.depositTerbayar += s.depositPaid;
    const target = resolveDailyTarget(s) * s.activeDays;
    acc.tagihanSetoran += Math.max(0, target - s.setoranPaid);
    if (s.lastDate >= acc.lastDate) {
      acc.lastDate = s.lastDate;
      acc.lastPlate = s.plate;
    }
    if (!acc.cabang && s.serviceArea) acc.cabang = s.serviceArea;
    if (!acc.koordinator && s.rentalPartner) acc.koordinator = s.rentalPartner;
  }

  for (const s of grab) {
    const acc = upsert(s.driverName, s.plate);
    if (s.lastDate >= acc.lastDate) {
      acc.lastDate = s.lastDate;
      acc.lastPlate = s.plate;
    }
    if (!acc.phone && s.phone) acc.phone = s.phone;
    if (!acc.cabang && s.city) acc.cabang = s.city;
    if (!acc.koordinator && s.rentalPartner) acc.koordinator = s.rentalPartner;
  }

  return [...byDriver.values()].map((acc) => {
    const tagihanEtle = 0; // belum ada sumber data (R1)
    const tagihanOwnRisk = 0; // belum ada sumber data (R1)
    const cicilanLainnya: number | null = null; // kolom disiapkan, logika menyusul
    const totalTagihan = acc.tagihanSetoran + tagihanEtle + tagihanOwnRisk + (cicilanLainnya ?? 0);
    return {
      driverName: acc.driverName,
      cabang: acc.cabang || EMPTY_LABEL,
      koordinator: acc.koordinator || EMPTY_LABEL,
      lastPlate: acc.lastPlate,
      phone: acc.phone,
      // aktif = the driver still appears in the freshest imported period, so
      // the flag self-adjusts when imports lag behind the calendar
      status: period !== '' && acc.lastDate.slice(0, 7) === period ? 'aktif' : 'nonaktif',
      depositTerbayar: acc.depositTerbayar,
      tagihanSetoran: acc.tagihanSetoran,
      tagihanEtle,
      tagihanOwnRisk,
      cicilanLainnya,
      totalTagihan,
      selisihDeposit: acc.depositTerbayar - totalTagihan,
    };
  });
}

/** Dropdown options, computed from the FULL row set before any filtering. */
export function buildDebtFilters(rows: DebtRowDto[]): DebtFiltersDto {
  const cabang = [...new Set(rows.map((r) => r.cabang).filter((c) => c !== EMPTY_LABEL))].sort();
  const koordinator = [
    ...new Set(rows.map((r) => r.koordinator).filter((k) => k !== EMPTY_LABEL)),
  ].sort();
  return { cabang, koordinator };
}

export function filterDebtRows(rows: DebtRowDto[], q: DebtQuery): DebtRowDto[] {
  let out = rows;
  if (q.status) out = out.filter((r) => r.status === q.status);
  if (q.cabang) out = out.filter((r) => r.cabang === q.cabang);
  if (q.koordinator) out = out.filter((r) => r.koordinator === q.koordinator);
  const needle = (q.search ?? '').trim().toUpperCase();
  if (needle) {
    const plateNeedle = needle.replace(/[^A-Z0-9]/g, '');
    out = out.filter(
      (r) =>
        r.driverName.includes(needle) || (plateNeedle !== '' && r.lastPlate.includes(plateNeedle)),
    );
  }
  return out;
}

export function sortDebtRows(rows: DebtRowDto[], q: DebtQuery): DebtRowDto[] {
  const dir = q.sortOrder === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const va = a[q.sortBy];
    const vb = b[q.sortBy];
    const cmp =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'id');
    // stable tiebreaker so pagination never shows a row twice
    return dir * cmp || a.driverName.localeCompare(b.driverName, 'id');
  });
}

export function paginateDebtRows(
  rows: DebtRowDto[],
  page: number,
  pageSize: number,
): { data: DebtRowDto[]; meta: { page: number; pageSize: number; total: number } } {
  const start = (page - 1) * pageSize;
  return {
    data: rows.slice(start, start + pageSize),
    meta: { page, pageSize, total: rows.length },
  };
}
