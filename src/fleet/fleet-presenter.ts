/**
 * Presentation layer: maps the internal Gojek grid result → the API shape the
 * frontend fleet model consumes (features/fleet/types.ts). DISPLAY-ONLY: every
 * rupiah figure and cell flag here is already backend-computed; the client never
 * re-derives money. One presenter serves BOTH the admin and the partner-portal
 * fleet endpoints, so the wire contract has a single source of truth.
 */
import type { MonitoringMode } from '../common/util/monitoring-mode';
import type { DueSegment } from './due-segments';
import {
  DailyDetailBucket,
  GojekGridResult,
  GojekVehicleRow,
  NO_RENTAL_PARTNER,
} from './gojek-grid.types';
import type { RangeSummaryDto } from './range-summary';

// ---- API DTOs (mirror the frontend fleet types) -----------------------------

export interface CellBreakdownItemDto {
  label: string;
  displayAmount: number;
  countedAmount: number;
  note: string | null;
  isDisplayOnly: boolean;
  // Backing fleet_import_details ids — non-empty for Manual Payment items only,
  // so the admin modal can open each one in the Edit form (re-toggle setoran).
  detailIds: number[];
}

export interface CellBreakdownDto {
  plateNorm: string;
  day: number;
  displayTotal: number;
  countedTotal: number;
  hasDisplayOnlyManualPayment: boolean;
  items: CellBreakdownItemDto[];
}

/**
 * Everything the cell's COLOUR is derived from — the legacy spreadsheet legend
 * (hijau sesuai target · kuning kurang · merah Rp0 · ungu manual · oranye
 * gabungan · biru bebas setoran · abu tidak beroperasi). Split out of
 * {@link DayCellValueDto} so All Fleet Monitoring can carry the very same facts
 * and reach the very same verdict without re-implementing the rules.
 */
export interface DayFactsDto {
  displayAmount: number;
  countedAmount: number;
  isManualPayment?: boolean;
  hasDisplayOnlyManualPayment?: boolean;
  isMixed?: boolean;
  exception?: { isBebasSetoran: boolean; keterangan: string | null } | null;
}

export interface DayCellValueDto extends DayFactsDto {
  day: number;
  detail?: CellBreakdownDto | null;
}

export interface FleetRowDto {
  // Row identity: a normalized plate, or `drv:<NAME>` in driver mode.
  plateNorm: string;
  plateRaw: string;
  driverName: string;
  rentalPartner: string;
  regionName: string;
  vehicleType: string;
  deliveryBatch: string;
  carId: number | null;
  // Set only for synthetic "Manual Payment tanpa plat" rows (pivot key
  // manual_<detailId>). It is the fleet_import_details.id of that single record,
  // so the Aksi → Edit form can reassign a plate / toggle Masuk Setoran on it.
  detailId: number | null;
  dailyTarget: number;
  // The month's due amounts per day and their RLE ranges. When the target
  // changed mid-month (>1 segment) the Setoran column lists each value with its
  // active day range; dailyDue is also the per-day cell-tone baseline.
  dailyDue: Record<number, number>;
  dueSegments: DueSegment[];
  days: Record<number, DayCellValueDto>;
  summary: {
    totalDeduction: number;
    // "Total Due (Target)" — Σ of the due rows actually imported this month,
    // bebas-setoran and Rental Monitoring days waived. Never extrapolated to
    // days that have not elapsed or were never billed.
    calculatedTarget: number;
    gap: number;
    // The span calculatedTarget covers, so the UI can explain the figure
    // ("21–24 · 4 hari"). billedDays === 0 → nothing billed, from/to null.
    billedDays: number;
    billFromDay: number | null;
    billToDay: number | null;
    // Cumulative balance (Σ due − Σ paid) from the plate's first imported row
    // up to the END of the selected month; outstandingMonth is that month's
    // own delta (outstanding = previous-month outstanding + outstandingMonth).
    outstanding: number;
    outstandingMonth: number;
  };
  driverHistory: string[];
  // Mirror of driverHistory: the plates behind this row. Plate mode → its own
  // plate; driver mode → every plate the person drove that month.
  plateHistory: string[];
  // Driver keluar: the subject (plate, or person in driver mode) no longer
  // appears in the newest import — auto-clears when it reappears.
  // exitedLastSeen = last import date it was seen (YYYY-MM-DD).
  isExited: boolean;
  exitedLastSeen: string | null;
  // Plate first appeared inside the selected month — a new joiner, whose lower
  // Total Due reflects a shorter month, not underpayment. joinDate is its first
  // imported transaction date (YYYY-MM-DD).
  isNewJoiner: boolean;
  joinDate: string | null;
}

// "Data Mentah Tanpa Plat": an unprocessed Manual Payment row imported without
// a plate. Excluded from rows/totals until an admin processes it (edit-driver).
export interface RawManualRowDto {
  detailId: number;
  transactionDate: string; // YYYY-MM-DD
  driverName: string;
  amount: number;
  isManualPaymentSetoran: number | null;
  note: string | null;
}

export interface FleetGridDto {
  month: number;
  year: number;
  daysInMonth: number;
  // Echo of the requested reading mode ('plate' | 'driver') so the client can
  // label the identity columns without trusting its own URL state.
  mode: MonitoringMode;
  rows: FleetRowDto[];
  dailyTotals: Record<number, number>;
  tableTotals: {
    totalDeduction: number;
    totalDue: number;
    outstanding: number;
    outstandingMonth: number;
  };
  // Admin processing queue — always empty under partner scoping.
  rawRows: RawManualRowDto[];
  rawTotalAmount: number;
  availableRentalPartners: string[];
  availablePlates: { plate: string; type: string }[];
  // Options of the "Tipe Kendaraan" filter (?vehicleType=), unaffected by the
  // current selection so the dropdown never shrinks as the reader picks.
  availableVehicleTypes: string[];
}

export interface GlobalSummaryDto {
  totalDeduction: number;
  totalDue: number;
  totalOutstanding: number; // active plates only — cumulative up to the selected month
  totalOutstandingMonth: number; // active plates only — the selected month's delta
  // Card "Outstanding Driver Keluar": all-time balance of plates that stopped
  // appearing in imports, and how many of them still owe (non-zero balance).
  outstandingDriverKeluar: number;
  exitedCount: number;
}
export interface FleetChartsDto {
  daily: { day: number; total: number }[];
  byPartner: { partner: string; total: number }[];
}
export interface InactiveDriverDto {
  name: string;
  status: string;
  vehicle: string;
}
export interface DriverActivityDto {
  day: number;
  availableDays: number[];
  maxDayInData: number;
  activeDrivers: number;
  inactiveDrivers: number;
  selectedDayTotalDeduction: number;
  inactiveList: InactiveDriverDto[];
}
export interface ExitedDriverDto {
  driverName: string;
  plate: string;
  lastSeen: string; // YYYY-MM-DD of the plate's last import row
  outstanding: number;
}

export interface GojekSummaryDto {
  globalSummary: GlobalSummaryDto;
  // Present only when the request sent ?dateFrom&dateTo (the Tanggal filter);
  // every other field keeps its whole-month semantics regardless, so the
  // all-time Driver Keluar card and the partner options stay valid.
  range?: RangeSummaryDto;
  driverActivity: DriverActivityDto;
  charts: FleetChartsDto;
  // Filter options for the dashboard's rental-partner select — computed over
  // the UNFILTERED grid so options don't disappear once a filter is applied.
  availableRentalPartners: string[];
  // Click-through detail of the Outstanding Driver Keluar card: non-zero-
  // balance exited plates, outstanding descending (legacy exitedDriversModal),
  // plus the newest import date for the modal's "data terakhir" subtitle.
  exitedDrivers: ExitedDriverDto[];
  lastImportDate: string | null;
}

// ---- mappers ---------------------------------------------------------------

export function toCellBreakdown(
  bucket: DailyDetailBucket,
  plateNorm: string,
  day: number,
): CellBreakdownDto {
  return {
    plateNorm,
    day,
    displayTotal: bucket.displayTotal,
    countedTotal: bucket.countedTotal,
    hasDisplayOnlyManualPayment: bucket.hasDisplayOnlyManualPayment,
    items: bucket.items.map((i) => ({
      label: i.label,
      displayAmount: i.displayAmount,
      countedAmount: i.countedAmount,
      note: i.note === '' ? null : i.note,
      isDisplayOnly: i.isDisplayOnly,
      detailIds: i.detailIds,
    })),
  };
}

// The exact labels buildBreakdownLabel emits for manual-payment items; used to
// tell manual vs deduction items apart WITHOUT a substring test (a deduction
// type like "Manual adjustment deduction" must not count as manual).
const MANUAL_LABELS = new Set(['Manual Payment', 'Manual Payment (Tidak Masuk Setoran)']);

/**
 * The colour-bearing facts of one day. Exported because All Fleet Monitoring
 * feeds them into the SAME client-side tone function as this grid does — one
 * rule, two screens, no chance of the two legends drifting apart.
 */
export function gojekDayFacts(row: GojekVehicleRow, day: number): DayFactsDto {
  const bucket = row.dailyDetails[day];
  const exc = row.exceptions[day];
  // Mixed = a real manual payment AND a (non-manual) deduction on the same day.
  // Manual is the authoritative manualPaymentDays flag, not a label match.
  const isMixed =
    row.manualPaymentDays.includes(day) &&
    !!bucket &&
    bucket.items.some((i) => !MANUAL_LABELS.has(i.label));
  return {
    displayAmount: row.dailyData[day] ?? 0,
    countedAmount: row.dailyCountedData[day] ?? 0,
    ...(row.manualPaymentDays.includes(day) ? { isManualPayment: true } : {}),
    ...(row.manualPaymentDisplayOnlyDays.includes(day)
      ? { hasDisplayOnlyManualPayment: true }
      : {}),
    ...(isMixed ? { isMixed: true } : {}),
    exception: exc ? { isBebasSetoran: exc.isBebasSetoran, keterangan: exc.keterangan } : null,
  };
}

/** Every day the grid has something to say about: money, or an exception. */
export function gojekActiveDays(row: GojekVehicleRow): number[] {
  return [
    ...new Set<number>([
      ...Object.keys(row.dailyData).map(Number),
      ...Object.keys(row.exceptions).map(Number),
    ]),
  ];
}

function dayCell(row: GojekVehicleRow, day: number): DayCellValueDto {
  const bucket = row.dailyDetails[day];
  return {
    day,
    ...gojekDayFacts(row, day),
    detail: bucket ? toCellBreakdown(bucket, row.key, day) : null,
  };
}

function toFleetRow(row: GojekVehicleRow): FleetRowDto {
  const days: Record<number, DayCellValueDto> = {};
  for (const day of gojekActiveDays(row)) days[day] = dayCell(row, day);

  return {
    plateNorm: row.key,
    // A real plate renders as-is; a "Manual Payment tanpa plat" synthetic row
    // (vehicle === '') stays blank so the grid shows a "Tanpa Plat" badge rather
    // than leaking the internal manual_<id> key.
    plateRaw: row.vehicle,
    driverName: row.driverName,
    rentalPartner: row.rentalPartner,
    regionName: '', // region name resolution is out of R1 scope (only regionId is stored)
    vehicleType: row.vehicleType,
    deliveryBatch: row.deliveryBatch,
    carId: row.targetId,
    detailId: row.detailId,
    dailyTarget: row.dailyTarget,
    dailyDue: row.dailyDue,
    dueSegments: row.dueSegments,
    days,
    summary: {
      totalDeduction: row.totalDeduction,
      calculatedTarget: row.calculatedTarget,
      gap: row.totalDeduction - row.calculatedTarget,
      billedDays: row.billedDays,
      billFromDay: row.billFromDay,
      billToDay: row.billToDay,
      outstanding: row.outstanding,
      outstandingMonth: row.outstandingMonth,
    },
    driverHistory: row.driverHistory,
    plateHistory: row.plateHistory,
    isExited: row.isExited,
    exitedLastSeen: row.exitedLastSeen,
    isNewJoiner: row.isNewJoiner,
    joinDate: row.firstSeen,
  };
}

export function toFleetGrid(result: GojekGridResult): FleetGridDto {
  return {
    month: result.month,
    year: result.year,
    daysInMonth: result.daysInMonth,
    mode: result.mode,
    rows: result.rows.map(toFleetRow),
    dailyTotals: result.dailyTotals,
    tableTotals: {
      totalDeduction: result.totalDeduction,
      totalDue: result.totalCalculatedTarget,
      outstanding: result.totalOutstanding,
      outstandingMonth: result.totalOutstandingMonth,
    },
    rawRows: result.rawRows.map((r) => ({
      detailId: r.detailId,
      transactionDate: r.transactionDate,
      driverName: r.driverName,
      amount: r.amount,
      isManualPaymentSetoran: r.isManualPaymentSetoran,
      note: r.note,
    })),
    rawTotalAmount: result.rawTotalAmount,
    availableRentalPartners: result.availableRentalPartners,
    availablePlates: result.availablePlates,
    availableVehicleTypes: result.availableVehicleTypes,
  };
}

// ---- dashboard summary (cards + driver activity + charts) -------------------

function toGlobalSummary(result: GojekGridResult): GlobalSummaryDto {
  return {
    totalDeduction: result.totalDeduction,
    totalDue: result.totalCalculatedTarget,
    totalOutstanding: result.totalOutstanding,
    totalOutstandingMonth: result.totalOutstandingMonth,
    outstandingDriverKeluar: result.outstandingDriverKeluar,
    exitedCount: result.exitedCount,
  };
}

function toCharts(result: GojekGridResult): FleetChartsDto {
  const daily = Array.from({ length: result.daysInMonth }, (_, i) => ({
    day: i + 1,
    total: result.dailyTotals[i + 1] ?? 0,
  }));
  const byPartnerMap = new Map<string, number>();
  for (const r of result.rows) {
    const partner = r.rentalPartner || NO_RENTAL_PARTNER;
    byPartnerMap.set(partner, (byPartnerMap.get(partner) ?? 0) + r.totalDeduction);
  }
  const byPartner = [...byPartnerMap.entries()]
    .map(([partner, total]) => ({ partner, total }))
    .sort((a, b) => b.total - a.total);
  return { daily, byPartner };
}

function toDriverActivity(result: GojekGridResult): DriverActivityDto {
  const dim = result.daysInMonth;
  const availableDays = Array.from({ length: dim }, (_, i) => i + 1);
  let maxDayInData = 1;
  for (let d = 1; d <= dim; d++) if ((result.dailyTotals[d] ?? 0) > 0) maxDayInData = d;
  const selectedDay = maxDayInData;

  // Same predicate for both partitions guarantees active + inactive === total.
  const active = result.rows.filter((r) => (r.dailyCountedData[selectedDay] ?? 0) > 0);
  const inactive = result.rows.filter((r) => (r.dailyCountedData[selectedDay] ?? 0) === 0);

  return {
    day: selectedDay,
    availableDays,
    maxDayInData,
    activeDrivers: active.length,
    inactiveDrivers: inactive.length,
    selectedDayTotalDeduction: result.dailyTotals[selectedDay] ?? 0,
    inactiveList: inactive.slice(0, 25).map((r) => {
      const exc = r.exceptions[selectedDay];
      const status = exc
        ? exc.isBebasSetoran
          ? 'Rental (bebas setoran)'
          : 'Tidak beroperasi'
        : 'Belum setor';
      // FE badges the unplated case specially on the literal 'Tanpa Plat'.
      return { name: r.driverName, status, vehicle: r.vehicle || 'Tanpa Plat' };
    }),
  };
}

/**
 * @param result the SELECTED month's grid — every whole-month field comes from it.
 * @param range  pre-combined date-range aggregates (see combineGojekRange); the
 *   range may span other months entirely, which is why it arrives ready-made
 *   instead of being derived from `result`.
 */
export function toGojekSummary(result: GojekGridResult, range?: RangeSummaryDto): GojekSummaryDto {
  return {
    globalSummary: toGlobalSummary(result),
    ...(range ? { range } : {}),
    driverActivity: toDriverActivity(result),
    charts: toCharts(result),
    availableRentalPartners: result.availableRentalPartners,
    exitedDrivers: result.exitedDrivers,
    lastImportDate: result.lastImportDate,
  };
}
