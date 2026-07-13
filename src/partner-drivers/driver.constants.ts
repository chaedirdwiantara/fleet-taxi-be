/**
 * Constants for partner-portal driver management. Kinds/statuses are stable
 * enum strings shared with the FE via the OpenAPI contract.
 */
export const DRIVER_SOURCES = ['gojek', 'grab', 'manual'] as const;
export type DriverSource = (typeof DRIVER_SOURCES)[number];

export const DRIVER_DOCUMENT_KINDS = [
  'ktp',
  'sim',
  'skck',
  'deposit_proof',
  'deposit_return_proof',
] as const;
export type DriverDocumentKind = (typeof DRIVER_DOCUMENT_KINDS)[number];

export const DRIVER_DOCUMENT_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'application/pdf',
] as const;
export type DriverDocumentContentType = (typeof DRIVER_DOCUMENT_CONTENT_TYPES)[number];

export const DRIVER_DOCUMENT_EXTENSIONS: Record<DriverDocumentContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/** Hard cap per document object (scans/photos of KTP, SIM, SKCK, bukti transfer). */
export const DRIVER_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const DRIVER_PRESIGN_PUT_TTL_SEC = 300;
export const DRIVER_PRESIGN_GET_TTL_SEC = 600;

/** Driver code assigned when a sync inserts the row: DRV- + zero-padded id (DRV-000123). */
export function formatDriverCode(id: number): string {
  return `DRV-${String(id).padStart(6, '0')}`;
}

/**
 * Sync identity for a driver name — MUST stay in agreement with the SQL
 * backfill in migration 0008: upper(regexp_replace(btrim(name), '\s+', ' ', 'g')).
 */
export function normalizeDriverName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}
