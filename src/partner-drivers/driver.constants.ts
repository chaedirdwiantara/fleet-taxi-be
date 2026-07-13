/**
 * Constants for partner-portal driver management. Kinds/statuses are stable
 * enum strings shared with the FE via the OpenAPI contract.
 */
export const DRIVER_REGISTRATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DriverRegistrationStatus = (typeof DRIVER_REGISTRATION_STATUSES)[number];

export const DRIVER_DEPOSIT_STATUSES = ['none', 'waiting', 'approved', 'rejected'] as const;
export type DriverDepositStatus = (typeof DRIVER_DEPOSIT_STATUSES)[number];

export const DRIVER_DOCUMENT_KINDS = [
  'ktp',
  'sim',
  'skck',
  'deposit_proof',
  'deposit_return_proof',
] as const;
export type DriverDocumentKind = (typeof DRIVER_DOCUMENT_KINDS)[number];

/** The three identity documents a partner ticks off before approval. */
export const DRIVER_CHECKABLE_DOC_KINDS = ['ktp', 'sim', 'skck'] as const;
export type DriverCheckableDocKind = (typeof DRIVER_CHECKABLE_DOC_KINDS)[number];

export const DRIVER_DECISION_ACTIONS = ['approve', 'reject'] as const;
export type DriverDecisionAction = (typeof DRIVER_DECISION_ACTIONS)[number];

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

/** Driver code assigned at approval: DRV- + zero-padded row id (DRV-000123). */
export function formatDriverCode(id: number): string {
  return `DRV-${String(id).padStart(6, '0')}`;
}
