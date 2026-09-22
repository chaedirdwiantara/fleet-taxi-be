/**
 * Constants for the signing block of rental invoices — who signs, and the
 * PNG signature / stamp artwork embedded when the partner asks for a signed
 * copy. Shared with the FE through the OpenAPI contract.
 */

export const INVOICE_ASSET_KINDS = ['signature', 'stamp'] as const;
export type InvoiceAssetKind = (typeof INVOICE_ASSET_KINDS)[number];

/** Only PNG: the artwork must carry transparency to sit over the stamp and page. */
export const INVOICE_ASSET_CONTENT_TYPE = 'image/png';

/** A trimmed signature or stamp is a few hundred KB; anything larger is a scan gone wrong. */
export const INVOICE_ASSET_MAX_BYTES = 2 * 1024 * 1024;

export const INVOICE_SIGNATURE_REQUIRED_MESSAGE =
  'Tanda tangan belum diunggah. Unggah gambar tanda tangan di "Atur Tanda Tangan" terlebih dahulu, atau unduh invoice tanpa tanda tangan.';
