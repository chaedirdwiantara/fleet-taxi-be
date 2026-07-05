/**
 * Byte-order string comparison matching PHP's `strcmp`, so grid row ordering
 * reproduces the legacy sort exactly (localeCompare is locale-aware and
 * case-folding, which reorders mixed-case/punctuated names differently).
 */
export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
