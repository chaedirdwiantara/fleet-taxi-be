export interface BreakdownItem {
  label: string;
  displayAmount: number;
  countedAmount: number;
  isDisplayOnly: boolean;
  note: string;
}

export interface DailyDetailBucket {
  items: BreakdownItem[];
  displayTotal: number;
  countedTotal: number;
  hasDisplayOnlyManualPayment: boolean;
}

export interface ExceptionInfo {
  keterangan: string | null;
  isBebasSetoran: boolean;
}

export interface GojekVehicleRow {
  key: string; // normalized plate or manual_<detailId>
  detailId: number | null; // set for synthetic manual_ rows (edit form target)
  driverName: string;
  driverHistory: string[];
  vehicle: string; // normalized plate ('' for unplated manual payments)
  rentalPartner: string;
  deliveryBatch: string;
  serviceArea: string;
  vehicleType: string;
  regionId: number | null;
  plateNotFound: boolean;
  targetId: number | null;
  dailyData: Record<number, number>; // display amounts per day
  dailyCountedData: Record<number, number>; // counted amounts per day
  dailyDetails: Record<number, DailyDetailBucket>;
  manualPaymentDays: number[];
  manualPaymentDisplayOnlyDays: number[];
  exceptions: Record<number, ExceptionInfo>;
  totalDeduction: number; // counted month total
  totalDisplayAmount: number;
  totalDue: number;
  dueCount: number;
  dailyTarget: number;
  calculatedTarget: number;
  activeDays: number;
  minDay: number;
  outstanding: number;
}

export interface GojekPerformer {
  driverName: string;
  vehicle: string; // comma-joined plates
  totalDeduction: number;
  outstanding: number;
}

export interface GojekGridResult {
  month: number;
  year: number;
  daysInMonth: number;
  rows: GojekVehicleRow[];
  dailyTotals: Record<number, number>; // counted, over filtered rows
  totalDeduction: number;
  totalCalculatedTarget: number;
  totalOutstanding: number;
  availableRentalPartners: string[];
  availablePlates: Array<{ plate: string; type: string }>;
  topPerformers: GojekPerformer[];
  bottomPerformers: GojekPerformer[];
}

export const NO_RENTAL_PARTNER = '(Tanpa Rental Partner)';
export const DEFAULT_DAILY_TARGET = 488000;
