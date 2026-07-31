/**
 * Fixed inspection template for vehicle-handover checkpoints. Keys are stable
 * enum strings shared with the FE via the OpenAPI contract; labels are the
 * Indonesian display strings used by the generated PDF (berita acara).
 */
export const CHECKPOINT_POINT_KEYS = [
  'exterior_front',
  'exterior_rear',
  'exterior_left',
  'exterior_right',
  'interior_front',
  'interior_rear',
  'dashboard_odometer',
  'tires_wheels',
  'charging_port',
  'keys_documents',
] as const;

export type CheckpointPointKey = (typeof CHECKPOINT_POINT_KEYS)[number];

export const CHECKPOINT_POINT_LABELS: Record<CheckpointPointKey, string> = {
  exterior_front: 'Eksterior Depan (bumper, kap, lampu, kaca depan)',
  exterior_rear: 'Eksterior Belakang (bumper, pintu bagasi, lampu)',
  exterior_left: 'Eksterior Sisi Kiri (pintu, spion, bodi)',
  exterior_right: 'Eksterior Sisi Kanan (pintu, spion, bodi)',
  interior_front: 'Interior Depan (jok, kemudi, layar)',
  interior_rear: 'Interior Belakang (jok, lantai, plafon)',
  dashboard_odometer: 'Dasbor, Odometer & Indikator Baterai',
  tires_wheels: 'Ban & Pelek (kondisi 4 ban)',
  charging_port: 'Port Pengisian & Kabel Charger',
  keys_documents: 'Kunci & Kelengkapan Dokumen (STNK, e-toll)',
};

export const HANDOVER_TYPES = [
  'delivery_to_customer',
  'return_from_customer',
  'delivery_to_driver',
  'return_from_driver',
] as const;

export type HandoverType = (typeof HANDOVER_TYPES)[number];

export const HANDOVER_TYPE_LABELS: Record<HandoverType, string> = {
  delivery_to_customer: 'Penyerahan ke Customer',
  return_from_customer: 'Pengembalian dari Customer',
  delivery_to_driver: 'Penyerahan ke Driver',
  return_from_driver: 'Pengembalian dari Driver',
};

/** A return checkpoint is compared against the latest completed paired delivery. */
export const HANDOVER_COMPARISON_PAIR: Partial<Record<HandoverType, HandoverType>> = {
  return_from_customer: 'delivery_to_customer',
  return_from_driver: 'delivery_to_driver',
};

/**
 * The two sides of a handover. `partner` is the partner's own officer
 * (`partner_staff_name`, signature kind `signature_partner`); `counterpart` is
 * the external customer or driver (`counterpart_name`, `signature_counterpart`).
 */
export type HandoverParty = 'partner' | 'counterpart';

/**
 * Who hands the unit over, per handover type: the partner delivers, the
 * counterpart returns. The receiver is always the other side — so "penyerah"
 * and "penerima" are derived from this single mapping instead of being stored
 * twice.
 */
export const HANDOVER_GIVER: Record<HandoverType, HandoverParty> = {
  delivery_to_customer: 'partner',
  delivery_to_driver: 'partner',
  return_from_customer: 'counterpart',
  return_from_driver: 'counterpart',
};

export function handoverGiver(handoverType: string): HandoverParty {
  return HANDOVER_GIVER[handoverType as HandoverType] ?? 'partner';
}

export function handoverReceiver(handoverType: string): HandoverParty {
  return handoverGiver(handoverType) === 'partner' ? 'counterpart' : 'partner';
}

/** What the external side of the handover is — drives the FE's driver picker. */
export const HANDOVER_COUNTERPART_KIND: Record<HandoverType, 'customer' | 'driver'> = {
  delivery_to_customer: 'customer',
  return_from_customer: 'customer',
  delivery_to_driver: 'driver',
  return_from_driver: 'driver',
};

/** Display label of one side, e.g. "Petugas Partner" / "Driver". */
export function handoverPartyLabel(handoverType: string, party: HandoverParty): string {
  if (party === 'partner') return 'Petugas Partner';
  return HANDOVER_COUNTERPART_KIND[handoverType as HandoverType] === 'driver'
    ? 'Driver'
    : 'Customer';
}

export const CHECKPOINT_MEDIA_KINDS = [
  'photo',
  'signature_partner',
  'signature_counterpart',
] as const;
export type CheckpointMediaKind = (typeof CHECKPOINT_MEDIA_KINDS)[number];

export const CHECKPOINT_MEDIA_CONTENT_TYPES = ['image/jpeg', 'image/png'] as const;

/** Hard cap per media object; the FE compresses to ~200-500KB well below this. */
export const CHECKPOINT_MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export const CHECKPOINT_PRESIGN_PUT_TTL_SEC = 300;
export const CHECKPOINT_PRESIGN_GET_TTL_SEC = 600;
