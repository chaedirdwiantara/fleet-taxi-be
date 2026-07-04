import { parseGrabDate } from '../../common/util/dates';
import { cleanMoney, cleanNumeric, normalizePlate } from '../../common/util/plate';
import { cellString, isEmptyRow, ParsedGrabRow, RawRow, RowMapper } from './parser.types';

/**
 * Ported from legacy AdminFleetMonitoringGrabController::postImport.
 * Header row contains "driver name" or "plate number". composite_key is
 * plate|city|driver per the brief (legacy stored an md5 of date-plate-driver).
 */
export class GrabRowMapper implements RowMapper<ParsedGrabRow> {
  headerFound = false;
  private cols = {
    date: 0,
    plate: 1,
    city: 2,
    carModel: 3,
    driverName: 4,
    tiering: 5,
    partnerName: 6,
    phone: 7,
    hours: 8,
    bookings: 9,
    rides: 10,
    cancel: 11,
    fulfill: 12,
    driverCancelRate: 13,
    fare: 14,
    toll: 15,
    incentive: 16,
    earning: 17,
  };

  feed(row: RawRow): ParsedGrabRow | null {
    if (!this.headerFound) {
      this.tryHeader(row);
      return null;
    }
    if (isEmptyRow(row)) return null;

    const date = parseGrabDate(row[this.cols.date]);
    if (!date) return null;

    const plateNumber = cellString(row[this.cols.plate]) ?? '';
    const city = cellString(row[this.cols.city]);
    const driverName = cellString(row[this.cols.driverName]) ?? '';
    const plateNumberNorm = normalizePlate(plateNumber);

    return {
      date,
      plateNumber,
      plateNumberNorm,
      city,
      carModel: cellString(row[this.cols.carModel]),
      driverName,
      driverPhoneNumber: cellString(row[this.cols.phone]),
      tiering: cellString(row[this.cols.tiering]),
      partnerName: cellString(row[this.cols.partnerName]),
      totalOnlineHours: cleanNumeric(row[this.cols.hours]).toFixed(2),
      totalBookings: Math.trunc(cleanNumeric(row[this.cols.bookings])),
      totalRides: Math.trunc(cleanNumeric(row[this.cols.rides])),
      cancelByDriver: Math.trunc(cleanNumeric(row[this.cols.cancel])),
      fullfilmentRate: cleanNumeric(row[this.cols.fulfill]).toFixed(2),
      driverCancellationRate: cleanNumeric(row[this.cols.driverCancelRate]).toFixed(2),
      driverFare: cleanMoney(row[this.cols.fare]),
      tollAndOthers: cleanMoney(row[this.cols.toll]),
      totalIncentive: cleanMoney(row[this.cols.incentive]),
      totalEarningCollected: cleanMoney(row[this.cols.earning]),
      compositeKey: `${plateNumberNorm}|${city ?? ''}|${driverName}`,
    };
  }

  private tryHeader(row: RawRow): void {
    const hit = row.some(
      (c) =>
        typeof c === 'string' &&
        (c.toLowerCase().includes('driver name') || c.toLowerCase().includes('plate number')),
    );
    if (!hit) return;
    this.headerFound = true;

    const map: Record<string, number> = {};
    row.forEach((c, i) => {
      if (typeof c === 'string') map[c.trim().toLowerCase()] = i;
    });
    this.cols = {
      date: map['date'] ?? this.cols.date,
      plate: map['plate number'] ?? this.cols.plate,
      city: map['city'] ?? this.cols.city,
      carModel: map['car model'] ?? this.cols.carModel,
      driverName: map['driver name'] ?? this.cols.driverName,
      tiering: map['tiering'] ?? this.cols.tiering,
      partnerName: map['partner name'] ?? this.cols.partnerName,
      phone: map['driver phone number'] ?? this.cols.phone,
      hours: map['total online hours'] ?? this.cols.hours,
      bookings: map['total bookings'] ?? this.cols.bookings,
      rides: map['total rides'] ?? this.cols.rides,
      cancel: map['cancel by driver'] ?? this.cols.cancel,
      fulfill: map['fullfilment rate'] ?? this.cols.fulfill,
      driverCancelRate: map['driver cancellation rate'] ?? this.cols.driverCancelRate,
      fare: map['driver fare (idr)'] ?? this.cols.fare,
      toll: map['toll and others (idr)'] ?? this.cols.toll,
      incentive: map['total incentive (idr)'] ?? this.cols.incentive,
      earning: map['total earning collected (idr)'] ?? this.cols.earning,
    };
  }
}
