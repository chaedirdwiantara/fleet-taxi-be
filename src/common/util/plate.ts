/**
 * Canonical plate form (PROJECT-BRIEF.md §7): UPPERCASE, strip everything
 * outside [A-Z0-9]. Ported from legacy preg_replace('/[^A-Z0-9]/', '', strtoupper(plate)).
 */
export function normalizePlate(plate: string | null | undefined): string {
  if (!plate) return '';
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Ported from the legacy Grab importer's cleanNumber(): strips "Rp", spaces
 * and thousand-separator commas, then rounds to whole rupiah (§7: money is
 * integer rupiah, no decimals).
 */
export function cleanMoney(value: unknown): number {
  if (typeof value === 'number') return Math.round(value);
  if (typeof value !== 'string' || value === '') return 0;
  const cleaned = value.replace(/[Rp\s]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Same cleaning but keeps decimals (rates, online hours). */
export function cleanNumeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value === '') return 0;
  const cleaned = value.replace(/[Rp\s%]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
