/**
 * Presentation layer for the Grab grid — maps the internal result → the API
 * shape the frontend consumes (features/grab/types.ts). Display-only; one
 * presenter serves both the admin and the partner-portal Grab endpoints.
 */
import type { PerformersDto } from '../fleet/fleet-presenter';
import type { GrabGridResult, GrabVehicleRow } from './grab-grid.service';

export interface GrabRowDto {
  compositeKey: string;
  plateNumber: string;
  city: string;
  driverName: string;
  rentalPartner: string;
  tiering: string;
  vehicleType: string;
  driverPhone: string;
  days: Record<number, { earning: number }>;
  summary: {
    earning: number;
    incentive: number;
    driverFare: number;
    tollAndOthers: number;
    rides: number;
    onlineHours: number;
    bookings: number;
    cancellations: number;
    cancellationRate: number;
    fulfillmentRate: number;
  };
}

export interface GrabGridDto {
  month: number;
  year: number;
  daysInMonth: number;
  rows: GrabRowDto[];
  totals: { earning: number; driverFare: number; incentive: number };
  availableRentalPartners: string[];
  availableCities: string[];
}

export interface GrabDriverDetailDto {
  compositeKey: string;
  driverName: string;
  plateNumber: string;
  phone: string;
  onlineHours: number;
  bookings: number;
  rides: number;
  cancelByDriver: number;
  fulfillmentRate: number;
  cancellationRate: number;
  fare: number;
  toll: number;
  incentive: number;
  earning: number;
}

function toGrabRow(v: GrabVehicleRow): GrabRowDto {
  const days: Record<number, { earning: number }> = {};
  for (const [d, earning] of Object.entries(v.dailyData)) days[Number(d)] = { earning };
  return {
    compositeKey: v.key,
    plateNumber: v.plateNumber,
    city: v.city,
    driverName: v.driverName,
    rentalPartner: v.rentalPartner,
    tiering: v.tiering,
    vehicleType: v.vehicleType,
    driverPhone: v.details.phone ?? '',
    days,
    summary: {
      earning: v.totalEarningCollected,
      incentive: v.totalIncentive,
      driverFare: v.totalDriverFare,
      tollAndOthers: v.details.toll,
      rides: v.totalRides,
      onlineHours: v.details.onlineHours,
      bookings: v.details.bookings,
      cancellations: v.details.cancelByDriver,
      cancellationRate: v.details.cancellationRate,
      fulfillmentRate: v.details.fulfillmentRate,
    },
  };
}

export function toGrabGrid(result: GrabGridResult): GrabGridDto {
  return {
    month: result.month,
    year: result.year,
    daysInMonth: result.daysInMonth,
    rows: result.rows.map(toGrabRow),
    totals: {
      earning: result.totalEarnings,
      driverFare: result.totalDriverFare,
      incentive: result.totalIncentives,
    },
    // computed pre-filter by the service so filtering doesn't collapse the options
    availableRentalPartners: result.availableRentalPartners,
    availableCities: result.availableCities,
  };
}

export function toGrabDriverDetail(v: GrabVehicleRow): GrabDriverDetailDto {
  return {
    compositeKey: v.key,
    driverName: v.driverName,
    plateNumber: v.plateNumber,
    phone: v.details.phone ?? '',
    onlineHours: v.details.onlineHours,
    bookings: v.details.bookings,
    rides: v.details.rides,
    cancelByDriver: v.details.cancelByDriver,
    fulfillmentRate: v.details.fulfillmentRate,
    cancellationRate: v.details.cancellationRate,
    fare: v.details.fare,
    toll: v.details.toll,
    incentive: v.details.incentive,
    earning: v.details.earning,
  };
}

// ---- dashboard summary (cards + charts) -------------------------------------

export interface GrabSummaryDto {
  globalSummary: {
    totalEarning: number;
    totalDriverFare: number;
    totalIncentive: number;
    totalRides: number;
    activeVehicles: number;
  };
  // Shape deliberately matches FleetChartsDto so the FE chart panel is reused.
  charts: {
    daily: { day: number; total: number }[];
    byPartner: { partner: string; total: number }[];
  };
  // Computed over the UNFILTERED pivot so options don't disappear when filtered.
  availableRentalPartners: string[];
  lastImportDate: string | null;
}

const NO_RENTAL_PARTNER = 'Tanpa Rental Partner';

export function toGrabSummary(
  result: GrabGridResult,
  lastImportDate: string | null,
): GrabSummaryDto {
  const dailyTotals: Record<number, number> = {};
  const byPartnerMap = new Map<string, number>();
  let totalRides = 0;
  for (const row of result.rows) {
    for (const [d, earning] of Object.entries(row.dailyData)) {
      dailyTotals[Number(d)] = (dailyTotals[Number(d)] ?? 0) + earning;
    }
    const partner = row.rentalPartner || NO_RENTAL_PARTNER;
    byPartnerMap.set(partner, (byPartnerMap.get(partner) ?? 0) + row.totalEarningCollected);
    totalRides += row.totalRides;
  }
  const daily = Array.from({ length: result.daysInMonth }, (_, i) => ({
    day: i + 1,
    total: dailyTotals[i + 1] ?? 0,
  }));
  const byPartner = [...byPartnerMap.entries()]
    .map(([partner, total]) => ({ partner, total }))
    .sort((a, b) => b.total - a.total);

  return {
    globalSummary: {
      totalEarning: result.totalEarnings,
      totalDriverFare: result.totalDriverFare,
      totalIncentive: result.totalIncentives,
      totalRides,
      activeVehicles: result.rows.length,
    },
    charts: { daily, byPartner },
    availableRentalPartners: result.availableRentalPartners,
    lastImportDate,
  };
}

/** Top/bottom 10 by total earning collected (legacy performers panel). */
export function toGrabPerformers(rows: GrabVehicleRow[]): PerformersDto {
  const sorted = [...rows].sort((a, b) => b.totalEarningCollected - a.totalEarningCollected);
  const toDto = (v: GrabVehicleRow) => ({
    key: v.key,
    driverName: v.driverName,
    vehicle: v.plateNumber,
    totalDeduction: v.totalEarningCollected,
    outstanding: 0,
  });
  return { top: sorted.slice(0, 10).map(toDto), bottom: sorted.slice(-10).reverse().map(toDto) };
}
