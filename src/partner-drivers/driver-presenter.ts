/**
 * Presentation layer for partner-portal driver management: pure functions
 * mapping drivers / driver_documents rows to camelCase API view objects.
 * Document URLs (presigned S3 GET in prod, dev file endpoint otherwise) are
 * resolved by the service and passed in, so everything here stays pure and
 * unit-testable without storage.
 */
import { driverDocuments, drivers } from '../db/schema';

export type DriverRow = typeof drivers.$inferSelect;
export type DriverDocumentRow = typeof driverDocuments.$inferSelect;

export interface DriverDocumentView {
  id: number;
  kind: string;
  contentType: string;
  status: string;
  /** Present for uploaded documents only. */
  url?: string;
}

/** Shared master-data fields of every driver view. */
interface DriverBase {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  ktpNo: string | null;
  simNo: string | null;
  simExpired: string | null;
  driverCode: string | null;
  plateNumber: string | null;
  bankAccount: string | null;
}

export interface DriverRegistrationSummary extends DriverBase {
  registrationStatus: string;
  rejectNote: string | null;
  ktpVerified: boolean;
  simVerified: boolean;
  skckVerified: boolean;
  depositAmount: number;
  depositStatus: string;
  createdAt: string;
}

export interface DriverRegistrationDetail extends DriverRegistrationSummary {
  depositNote: string | null;
  depositDecidedAt: string | null;
  updatedAt: string;
  documents: DriverDocumentView[];
}

export interface DriverSummary extends DriverBase {
  isActive: boolean;
  depositAmount: number;
  depositStatus: string;
  joinedAt: string;
}

export interface DriverDetail extends DriverSummary {
  depositNote: string | null;
  depositDecidedAt: string | null;
  updatedAt: string;
  documents: DriverDocumentView[];
}

export interface DriverResignationSummary extends DriverBase {
  depositAmount: number;
  depositReturnStatus: string;
  depositReturnDecidedAt: string | null;
  resignedAt: string;
  joinedAt: string;
}

export interface DriverResignationDetail extends DriverResignationSummary {
  depositStatus: string;
  updatedAt: string;
  documents: DriverDocumentView[];
}

function base(row: DriverRow): DriverBase {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    ktpNo: row.ktpNo,
    simNo: row.simNo,
    simExpired: row.simExpired,
    driverCode: row.driverCode,
    plateNumber: row.plateNumber,
    bankAccount: row.bankAccount,
  };
}

export function presentDocument(row: DriverDocumentRow, url?: string): DriverDocumentView {
  return {
    id: row.id,
    kind: row.kind,
    contentType: row.contentType,
    status: row.status,
    ...(url !== undefined && { url }),
  };
}

export function presentRegistrationSummary(row: DriverRow): DriverRegistrationSummary {
  return {
    ...base(row),
    registrationStatus: row.registrationStatus,
    rejectNote: row.rejectNote,
    ktpVerified: row.ktpVerified,
    simVerified: row.simVerified,
    skckVerified: row.skckVerified,
    depositAmount: row.depositAmount,
    depositStatus: row.depositStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

export function presentRegistrationDetail(
  row: DriverRow,
  documents: DriverDocumentView[],
): DriverRegistrationDetail {
  return {
    ...presentRegistrationSummary(row),
    depositNote: row.depositNote,
    depositDecidedAt: row.depositDecidedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    documents,
  };
}

export function presentDriverSummary(row: DriverRow): DriverSummary {
  return {
    ...base(row),
    isActive: row.isActive,
    depositAmount: row.depositAmount,
    depositStatus: row.depositStatus,
    joinedAt: row.createdAt.toISOString(),
  };
}

export function presentDriverDetail(row: DriverRow, documents: DriverDocumentView[]): DriverDetail {
  return {
    ...presentDriverSummary(row),
    depositNote: row.depositNote,
    depositDecidedAt: row.depositDecidedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    documents,
  };
}

export function presentResignationSummary(row: DriverRow): DriverResignationSummary {
  return {
    ...base(row),
    depositAmount: row.depositAmount,
    depositReturnStatus: row.depositReturnStatus,
    depositReturnDecidedAt: row.depositReturnDecidedAt?.toISOString() ?? null,
    resignedAt: row.resignedAt!.toISOString(),
    joinedAt: row.createdAt.toISOString(),
  };
}

export function presentResignationDetail(
  row: DriverRow,
  documents: DriverDocumentView[],
): DriverResignationDetail {
  return {
    ...presentResignationSummary(row),
    depositStatus: row.depositStatus,
    updatedAt: row.updatedAt.toISOString(),
    documents,
  };
}
