/**
 * Byte-order string comparison matching PHP's `strcmp`, so grid row ordering
 * reproduces the legacy sort exactly (localeCompare is locale-aware and
 * case-folding, which reorders mixed-case/punctuated names differently).
 */
export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Built once: a grid re-collates a few thousand pairs per request. */
const vehicleTypeCollator = new Intl.Collator('id', { sensitivity: 'base', numeric: true });

/**
 * A→Z ordering of a vehicle Type, shared by every monitoring pivot that reads
 * per plate (Gojek, All Fleet, Rental Monitoring) so the three screens list one
 * fleet in the same order: the models grouped together, alphabetically.
 *
 * Deliberately NOT byteCompare: the Type is free text typed by admins
 * (fleet_targets) and partners (Daftarkan Plat) alike, so "BYD M6" and "Byd M6"
 * are one model and must not split into two blocks. `numeric` keeps
 * "ATTO 2" ahead of "ATTO 10". This matches the `availableVehicleTypes`
 * dropdown, which offers the values in the very same order.
 *
 * Untyped plates sort LAST — a row whose Type column reads "-" heading the
 * table looks like a data error, not like the start of the alphabet.
 */
export function compareVehicleType(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const left = (a ?? '').trim();
  const right = (b ?? '').trim();
  if (left === '' || right === '') return left === right ? 0 : left === '' ? 1 : -1;
  return vehicleTypeCollator.compare(left, right);
}
