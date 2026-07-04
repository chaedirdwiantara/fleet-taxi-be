import { parseGojekDate } from '../../common/util/dates';
import { cleanMoney, normalizePlate } from '../../common/util/plate';
import { cellString, isEmptyRow, ParsedGojekRow, RawRow, RowMapper } from './parser.types';

/**
 * Ported from legacy AdminFleetMonitoringController::postImport.
 * Header row is detected by a cell containing "gopay transaction"; column
 * positions come from the header map with the legacy fallback indexes.
 */
export class GojekRowMapper implements RowMapper<ParsedGojekRow> {
  headerFound = false;
  private cols = {
    date: 0,
    driverId: 1,
    driverName: 2,
    vehicle: 4,
    amount: 5,
    type: 7,
    reference: 8,
  };

  feed(row: RawRow): ParsedGojekRow | null {
    if (!this.headerFound) {
      this.tryHeader(row);
      return null;
    }
    if (isEmptyRow(row)) return null;

    const rawDate = row[this.cols.date];
    const transactionDate = parseGojekDate(rawDate);
    if (!transactionDate) return null; // legacy fell back to now(); we skip instead

    const type = cellString(row[this.cols.type]);
    // Legacy isManualPaymentType: stripos(type, 'Manual Payment') !== false
    const isManual = type !== null && type.toLowerCase().includes('manual payment');
    const vehiclePlate = cellString(row[this.cols.vehicle]);

    return {
      transactionDate,
      driverId: cellString(row[this.cols.driverId]),
      driverName: cellString(row[this.cols.driverName]),
      vehiclePlate,
      vehiclePlateNorm: normalizePlate(vehiclePlate),
      amount: cleanMoney(row[this.cols.amount]),
      type,
      isManualPaymentSetoran: isManual ? 1 : null, // legacy default: counted (1); admin can flip to 0 later
      referenceId: cellString(row[this.cols.reference]),
    };
  }

  private tryHeader(row: RawRow): void {
    const hit = row.some(
      (c) => typeof c === 'string' && c.toLowerCase().includes('gopay transaction'),
    );
    if (!hit) return;
    this.headerFound = true;

    const map: Record<string, number> = {};
    row.forEach((c, i) => {
      if (typeof c === 'string') map[c.trim().toLowerCase()] = i;
    });
    this.cols = {
      date: map['date & time(jkt)'] ?? map['date'] ?? this.cols.date,
      driverId: map['driver id'] ?? this.cols.driverId,
      driverName: map['driver name'] ?? this.cols.driverName,
      vehicle: map['vehicle'] ?? this.cols.vehicle,
      amount: map['amount'] ?? this.cols.amount,
      type: map['type'] ?? this.cols.type,
      reference: map['gopay transaction reference id'] ?? this.cols.reference,
    };
  }
}
