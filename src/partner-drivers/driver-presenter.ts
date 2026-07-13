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

export interface DriverSummary {
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
  source: string;
  isActive: boolean;
  depositAmount: number;
  resignedAt: string | null;
  depositReturnStatus: string;
  joinedAt: string;
}

export interface DriverDetail extends DriverSummary {
  depositReturnDecidedAt: string | null;
  updatedAt: string;
  documents: DriverDocumentView[];
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

export function presentDriverSummary(row: DriverRow): DriverSummary {
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
    source: row.source,
    isActive: row.isActive,
    depositAmount: row.depositAmount,
    resignedAt: row.resignedAt?.toISOString() ?? null,
    depositReturnStatus: row.depositReturnStatus,
    joinedAt: row.createdAt.toISOString(),
  };
}

export function presentDriverDetail(row: DriverRow, documents: DriverDocumentView[]): DriverDetail {
  return {
    ...presentDriverSummary(row),
    depositReturnDecidedAt: row.depositReturnDecidedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    documents,
  };
}
