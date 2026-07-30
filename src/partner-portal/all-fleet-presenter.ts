/**
 * Wire shape of All Fleet Monitoring. DISPLAY-ONLY, like every other presenter
 * here: the matrix builder already produced final integer-rupiah figures, this
 * file just names them for the client.
 */
import type { MonitoringMode } from '../common/util/monitoring-mode';
import type { AllFleetMatrix, AllFleetRow, AllFleetSource } from './all-fleet-matrix';

export interface AllFleetDayCellDto {
  gojek: number;
  grab: number;
  rental: number;
  total: number;
  /** Subject appears in that day's data but earned Rp 0 (distinct from "no data"). */
  isZero: boolean;
}

export interface AllFleetHistoryEntryDto {
  label: string;
  sublabel: string | null;
  fromDay: number;
  toDay: number;
}

export interface AllFleetTotalsDto {
  gojek: number;
  grab: number;
  rental: number;
  total: number;
}

export interface AllFleetRowDto {
  /** Row identity: normalized plate, `drv:<NAME>`, or `residual`. */
  key: string;
  label: string;
  /** "Denza · Jakarta" in plate mode; null when there is nothing to add. */
  sublabel: string | null;
  /** The mirror subject: drivers of this plate, or plates this driver used. */
  history: AllFleetHistoryEntryDto[];
  /** Sparse: only days with data are present. */
  days: Record<number, AllFleetDayCellDto>;
  totals: AllFleetTotalsDto;
}

export interface AllFleetGridDto {
  month: number;
  year: number;
  daysInMonth: number;
  mode: MonitoringMode;
  rows: AllFleetRowDto[];
  /**
   * Income that belongs to no subject in this mode — "Tanpa driver" (all Rental
   * omset, since Rental Monitoring records no driver, plus import rows with an
   * empty driver name) or "Tanpa plat". `null` when everything is attributable.
   * Its amounts ARE included in `totals`.
   */
  residual: AllFleetRowDto | null;
  dailyTotals: Record<number, AllFleetDayCellDto>;
  totals: AllFleetTotalsDto;
  /** Rows in the table, and how many of them actually earned something. */
  subjectCount: number;
  activeCount: number;
}

// ---- cell drill-down ---------------------------------------------------------

export interface AllFleetCellItemDto {
  label: string;
  sublabel: string | null;
  amount: number;
  note: string | null;
}

export interface AllFleetCellSourceDto {
  source: AllFleetSource;
  total: number;
  items: AllFleetCellItemDto[];
}

export interface AllFleetCellDto {
  key: string;
  label: string;
  date: string; // YYYY-MM-DD
  total: number;
  /** Only sources that have something on that day, in Gojek → Grab → Rental order. */
  sources: AllFleetCellSourceDto[];
}

// ---- mappers ----------------------------------------------------------------

function toRow(row: AllFleetRow): AllFleetRowDto {
  return {
    key: row.key,
    label: row.label,
    sublabel: row.sublabel,
    history: row.history,
    days: row.days,
    totals: row.totals,
  };
}

export function toAllFleetGrid(
  matrix: AllFleetMatrix,
  period: { month: number; year: number; daysInMonth: number; mode: MonitoringMode },
): AllFleetGridDto {
  return {
    month: period.month,
    year: period.year,
    daysInMonth: period.daysInMonth,
    mode: period.mode,
    rows: matrix.rows.map(toRow),
    residual: matrix.residual ? toRow(matrix.residual) : null,
    dailyTotals: matrix.dailyTotals,
    totals: matrix.totals,
    subjectCount: matrix.subjectCount,
    activeCount: matrix.activeCount,
  };
}
