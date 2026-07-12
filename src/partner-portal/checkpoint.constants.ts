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
