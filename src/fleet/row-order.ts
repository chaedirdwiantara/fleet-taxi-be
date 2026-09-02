import { byteCompare, compareVehicleType } from '../common/util/sort';

/** The row fields the reading order depends on — nothing else is consulted. */
export interface OrderableRow {
  isExited: boolean;
  rentalPartner: string;
  vehicleType: string;
  driverName: string;
}

/**
 * Reading order of the Gojek monitoring table.
 *
 * Rows whose subject left the fleet sink to the bottom as one block. They still
 * have to be readable — their balance rarely lands on zero the day they go —
 * but they are not part of the fleet you are steering, and interleaving them
 * chops the active roster into fragments that cannot be compared plate to plate.
 *
 * Within each block: [Rental Partner on admin] → vehicle Type A→Z → driver name.
 * Type is what a reader compares one plate to another by, so the fleet is listed
 * model by model — inside a partner on the admin grid (whose Rental Partner
 * column is rowspan-merged and must stay contiguous), and straight away on the
 * partner portal, which has no such column. Driver rows carry no Type — a person
 * is not one model — so the middle key is skipped there and the legacy name
 * order stands. (legacy strcmp otherwise; the region_name tiebreaker is
 * intentionally dropped — region resolution is out of R1 scope)
 */
export function compareGojekRows(
  a: OrderableRow,
  b: OrderableRow,
  opts: { groupByRentalPartner?: boolean; byDriver?: boolean } = {},
): number {
  return (
    Number(a.isExited) - Number(b.isExited) ||
    (opts.groupByRentalPartner ? byteCompare(a.rentalPartner, b.rentalPartner) : 0) ||
    (opts.byDriver ? 0 : compareVehicleType(a.vehicleType, b.vehicleType)) ||
    byteCompare(a.driverName, b.driverName)
  );
}
