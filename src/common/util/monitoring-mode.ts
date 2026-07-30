/**
 * Reading mode for the fleet monitoring pivots: one row per PLATE (default) or
 * one row per DRIVER. Used uniformly by the Gojek grid, the Grab grid and the
 * partner-portal All Fleet matrix so the parameter name, the row-key shape and
 * the residual-row wording never differ between screens.
 *
 * The mode travels as a query param (`?mode=`) rather than a client-side toggle
 * because the rows genuinely differ — a driver row is not a re-arranged plate
 * row — and because a link then stays shareable.
 *
 * Money semantics are mode-independent: both modes sum the SAME import rows, so
 * every table total (setoran, due, outstanding, per-day totals) is identical in
 * both. Only the grouping key changes.
 */
import { normalizeDriverName } from '../../partner-drivers/driver.constants';

export const MONITORING_MODES = ['plate', 'driver'] as const;
export type MonitoringMode = (typeof MONITORING_MODES)[number];

/** Query-param name, shared by every monitoring endpoint. */
export const MONITORING_MODE_PARAM = 'mode';

/** Request value → validated mode; anything unexpected falls back to `plate`. */
export function parseMonitoringMode(raw?: string | null): MonitoringMode {
  return raw === 'driver' ? 'driver' : 'plate';
}

export function isDriverMode(mode: MonitoringMode): boolean {
  return mode === 'driver';
}

/** Row keys of driver-mode rows carry this prefix so they can never collide
 * with a normalized plate (which is `[A-Z0-9]` only). */
export const DRIVER_KEY_PREFIX = 'drv:';

/**
 * Pivot key for a driver row. The identity is `normalizeDriverName` — the same
 * one the driver roster and Cicilan Deposit use — so a driver is the same person
 * across every feature. Import rows with no driver name collapse into a single
 * explicit `drv:` bucket: that money cannot be attributed to anyone, and hiding
 * it would silently drop rupiah from the table.
 */
export function driverRowKey(name: string | null | undefined): string {
  return `${DRIVER_KEY_PREFIX}${normalizeDriverName(name ?? '')}`;
}

/** Display label for a driver row key ('' for the nameless bucket). */
export function driverLabelFromKey(key: string): string {
  return key.startsWith(DRIVER_KEY_PREFIX) ? key.slice(DRIVER_KEY_PREFIX.length) : key;
}
