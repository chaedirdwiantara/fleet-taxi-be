/**
 * Presentation layer: maps the internal Gojek grid result → the API shape the
 * frontend fleet model consumes (features/fleet/types.ts). DISPLAY-ONLY: every
 * rupiah figure and cell flag here is already backend-computed; the client never
 * re-derives money. One presenter serves BOTH the admin and the partner-portal
 * fleet endpoints, so the wire contract has a single source of truth.
 */
import type { DueSegment } from './due-segments';
import {
  DailyDetailBucket,
  GojekGridResult,
  GojekPerformer,
  GojekVehicleRow,
  NO_RENTAL_PARTNER,
} from './gojek-grid.types';

// ---- API DTOs (mirror the frontend fleet types) -----------------------------

export interface CellBreakdownItemDto {
  label: string;
  displayAmount: number;
  countedAmount: number;
  note: string | null;
  isDisplayOnly: boolean;
}

export interface CellBreakdownDto {
  plateNorm: string;
  day: number;
  displayTotal: number;
  countedTotal: number;
  hasDisplayOnlyManualPayment: boolean;
  items: CellBreakdownItemDto[];
}

export interface DayCellValueDto {
  day: number;
  displayAmount: number;
  countedAmount: number;
  isManualPayment?: boolean;
  hasDisplayOnlyManualPayment?: boolean;
  isMixed?: boolean;
  exception?: { isBebasSetoran: boolean; keterangan: string | null } | null;
  detail?: CellBreakdownDto | null;
}

export interface FleetRowDto {
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
  summary: { totalDeduction: number; calculatedTarget: number; gap: number; outstanding: number };
  driverHistory: string[];
  // Driver keluar: plate no longer appears in the newest import (auto-clears
  // when it reappears). exitedLastSeen = last import date it was seen (YYYY-MM-DD).
  isExited: boolean;
  exitedLastSeen: string | null;
}

export interface FleetGridDto {
  month: number;
  year: number;
  daysInMonth: number;
  rows: FleetRowDto[];
  dailyTotals: Record<number, number>;
  tableTotals: { totalDeduction: number; totalDue: number; outstanding: number };
  availableRentalPartners: string[];
  availablePlates: { plate: string; type: string }[];
}

export interface PerformerDto {
  key: string;
  driverName: string;
  vehicle: string;
  totalDeduction: number;
  outstanding: number;
}
export interface PerformersDto {
  top: PerformerDto[];
  bottom: PerformerDto[];
}

export interface GlobalSummaryDto {
  totalDeduction: number;
  totalDue: number;
  totalOutstanding: number; // active (non-exited) plates only
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
    })),
  };
}

// The exact labels buildBreakdownLabel emits for manual-payment items; used to
// tell manual vs deduction items apart WITHOUT a substring test (a deduction
// type like "Manual adjustment deduction" must not count as manual).
const MANUAL_LABELS = new Set(['Manual Payment', 'Manual Payment (Tidak Masuk Setoran)']);

function dayCell(row: GojekVehicleRow, day: number): DayCellValueDto {
  const bucket = row.dailyDetails[day];
  const exc = row.exceptions[day];
  // Mixed = a real manual payment AND a (non-manual) deduction on the same day.
  // Manual is the authoritative manualPaymentDays flag, not a label match.
  const isMixed =
    row.manualPaymentDays.includes(day) &&
    !!bucket &&
    bucket.items.some((i) => !MANUAL_LABELS.has(i.label));
  return {
    day,
    displayAmount: row.dailyData[day] ?? 0,
    countedAmount: row.dailyCountedData[day] ?? 0,
    ...(row.manualPaymentDays.includes(day) ? { isManualPayment: true } : {}),
    ...(row.manualPaymentDisplayOnlyDays.includes(day)
      ? { hasDisplayOnlyManualPayment: true }
      : {}),
    ...(isMixed ? { isMixed: true } : {}),
    exception: exc ? { isBebasSetoran: exc.isBebasSetoran, keterangan: exc.keterangan } : null,
    detail: bucket ? toCellBreakdown(bucket, row.key, day) : null,
  };
}

function toFleetRow(row: GojekVehicleRow): FleetRowDto {
  const days: Record<number, DayCellValueDto> = {};
  const activeDays = new Set<number>([
    ...Object.keys(row.dailyData).map(Number),
    ...Object.keys(row.exceptions).map(Number),
  ]);
  for (const day of activeDays) days[day] = dayCell(row, day);

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
      outstanding: row.outstanding,
    },
    driverHistory: row.driverHistory,
    isExited: row.isExited,
    exitedLastSeen: row.exitedLastSeen,
  };
}

export function toFleetGrid(result: GojekGridResult): FleetGridDto {
  return {
    month: result.month,
    year: result.year,
    daysInMonth: result.daysInMonth,
    rows: result.rows.map(toFleetRow),
    dailyTotals: result.dailyTotals,
    tableTotals: {
      totalDeduction: result.totalDeduction,
      totalDue: result.totalCalculatedTarget,
      outstanding: result.totalOutstanding,
    },
    availableRentalPartners: result.availableRentalPartners,
    availablePlates: result.availablePlates,
  };
}

export function toPerformers(p: {
  topPerformers: GojekPerformer[];
  bottomPerformers: GojekPerformer[];
}): PerformersDto {
  const toDto = (x: GojekPerformer): PerformerDto => ({
    key: x.vehicle || x.driverName,
    driverName: x.driverName,
    vehicle: x.vehicle,
    totalDeduction: x.totalDeduction,
    outstanding: x.outstanding,
  });
  return { top: p.topPerformers.map(toDto), bottom: p.bottomPerformers.map(toDto) };
}

// ---- dashboard summary (cards + driver activity + charts) -------------------

function toGlobalSummary(result: GojekGridResult): GlobalSummaryDto {
  return {
    totalDeduction: result.totalDeduction,
    totalDue: result.totalCalculatedTarget,
    totalOutstanding: result.totalOutstanding,
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

function toDriverActivity(result: GojekGridResult, day?: number): DriverActivityDto {
  const dim = result.daysInMonth;
  const availableDays = Array.from({ length: dim }, (_, i) => i + 1);
  let maxDayInData = 1;
  for (let d = 1; d <= dim; d++) if ((result.dailyTotals[d] ?? 0) > 0) maxDayInData = d;
  const selectedDay = day && day >= 1 && day <= dim ? day : maxDayInData;

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

export function toGojekSummary(result: GojekGridResult, day?: number): GojekSummaryDto {
  return {
    globalSummary: toGlobalSummary(result),
    driverActivity: toDriverActivity(result, day),
    charts: toCharts(result),
    availableRentalPartners: result.availableRentalPartners,
    exitedDrivers: result.exitedDrivers,
    lastImportDate: result.lastImportDate,
  };
}
