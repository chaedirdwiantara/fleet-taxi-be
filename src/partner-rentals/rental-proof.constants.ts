/**
 * Constants for rental payment evidence. Content types and the file cap are
 * stable values shared with the FE via the OpenAPI contract.
 */

export const RENTAL_PROOF_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type RentalProofContentType = (typeof RENTAL_PROOF_CONTENT_TYPES)[number];

export const RENTAL_PROOF_EXTENSIONS: Record<RentalProofContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};

/** Hard cap per uploaded object (photo or scan of a transfer receipt). */
export const RENTAL_MAX_PROOF_BYTES = 10 * 1024 * 1024;

/** A rental carries at most this many proofs; enforced on attach. */
export const RENTAL_MAX_PROOFS = 5;

export const RENTAL_PROOF_PRESIGN_PUT_TTL_SEC = 300;
export const RENTAL_PROOF_PRESIGN_GET_TTL_SEC = 600;

/**
 * Drafts (rental_id IS NULL) older than this are swept on the next presign of
 * the same partner — they are the residue of add-rental forms that were
 * abandoned after uploading. Comfortably longer than any real form session.
 */
export const RENTAL_PROOF_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export const RENTAL_PROOF_REQUIRED_MESSAGE =
  'Bukti pembayaran wajib diunggah (1–5 file) untuk menandai transaksi Sudah Dibayar.';
