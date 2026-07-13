import { describe, expect, it } from 'vitest';
import {
  DriverDocumentRow,
  DriverRow,
  presentDocument,
  presentDriverDetail,
  presentDriverSummary,
} from './driver-presenter';

function row(overrides: Partial<DriverRow> = {}): DriverRow {
  return {
    id: 42,
    partnerId: 10,
    name: 'Budi Santoso',
    nameNorm: 'BUDI SANTOSO',
    source: 'gojek',
    email: 'budi@example.com',
    phone: '0812xxxxxxx',
    address: 'Jl. Melati 1',
    ktpNo: '3174xxxxxxxxxxxx',
    simNo: 'SIM-123',
    simExpired: '2027-03-15',
    driverCode: 'DRV-000042',
    plateNumber: 'B 1793 SCP',
    plateNumberNorm: 'B1793SCP',
    bankAccount: 'BCA 1234567890',
    registrationStatus: 'approved',
    rejectNote: null,
    ktpVerified: false,
    simVerified: false,
    skckVerified: false,
    depositAmount: 1_500_000,
    depositStatus: 'none',
    depositNote: null,
    depositDecidedAt: null,
    isActive: true,
    resignedAt: null,
    depositReturnStatus: 'none',
    depositReturnDecidedAt: null,
    createdAt: new Date('2026-07-01T03:00:00Z'),
    updatedAt: new Date('2026-07-02T04:30:00Z'),
    ...overrides,
  };
}

function doc(overrides: Partial<DriverDocumentRow> = {}): DriverDocumentRow {
  return {
    id: 7,
    driverId: 42,
    kind: 'ktp',
    storageKey: 'partner/10/drivers/42/ktp/uuid.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 250_000,
    status: 'uploaded',
    createdAt: new Date('2026-07-01T03:05:00Z'),
    ...overrides,
  };
}

describe('presentDocument', () => {
  it('maps a document row and includes the url only when given', () => {
    expect(presentDocument(doc(), '/partner/portal/drivers/documents/7/file')).toEqual({
      id: 7,
      kind: 'ktp',
      contentType: 'image/jpeg',
      status: 'uploaded',
      url: '/partner/portal/drivers/documents/7/file',
    });
    expect(presentDocument(doc({ status: 'pending' }))).not.toHaveProperty('url');
  });
});

describe('presentDriverSummary', () => {
  it('maps a synced driver to camelCase with ISO timestamps', () => {
    const summary = presentDriverSummary(row());
    expect(summary).toMatchObject({
      id: 42,
      name: 'Budi Santoso',
      source: 'gojek',
      phone: '0812xxxxxxx',
      simExpired: '2027-03-15',
      driverCode: 'DRV-000042',
      plateNumber: 'B 1793 SCP',
      isActive: true,
      depositAmount: 1_500_000,
      resignedAt: null,
      depositReturnStatus: 'none',
      joinedAt: '2026-07-01T03:00:00.000Z',
    });
    // Internals / registration-era columns never leak
    expect(summary).not.toHaveProperty('partnerId');
    expect(summary).not.toHaveProperty('nameNorm');
    expect(summary).not.toHaveProperty('plateNumberNorm');
    expect(summary).not.toHaveProperty('registrationStatus');
    expect(summary).not.toHaveProperty('ktpVerified');
    expect(summary).not.toHaveProperty('depositStatus');
  });

  it('serializes resignedAt for resigned drivers', () => {
    const summary = presentDriverSummary(
      row({
        isActive: false,
        resignedAt: new Date('2026-07-10T08:00:00Z'),
        depositReturnStatus: 'approved',
      }),
    );
    expect(summary.resignedAt).toBe('2026-07-10T08:00:00.000Z');
    expect(summary.depositReturnStatus).toBe('approved');
    expect(summary.isActive).toBe(false);
  });
});

describe('presentDriverDetail', () => {
  it('adds deposit-return decision, updatedAt and documents', () => {
    const documents = [presentDocument(doc({ kind: 'deposit_return_proof' }), 'https://s3/signed')];
    const detail = presentDriverDetail(
      row({ depositReturnDecidedAt: new Date('2026-07-11T00:00:00Z') }),
      documents,
    );
    expect(detail.depositReturnDecidedAt).toBe('2026-07-11T00:00:00.000Z');
    expect(detail.updatedAt).toBe('2026-07-02T04:30:00.000Z');
    expect(detail.documents).toEqual(documents);
  });
});
