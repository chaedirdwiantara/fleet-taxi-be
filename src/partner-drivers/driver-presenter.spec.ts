import { describe, expect, it } from 'vitest';
import {
  DriverDocumentRow,
  DriverRow,
  presentDocument,
  presentDriverDetail,
  presentDriverSummary,
  presentRegistrationDetail,
  presentRegistrationSummary,
  presentResignationDetail,
  presentResignationSummary,
} from './driver-presenter';

function row(overrides: Partial<DriverRow> = {}): DriverRow {
  return {
    id: 42,
    partnerId: 10,
    name: 'Budi Santoso',
    email: 'budi@example.com',
    phone: '0812xxxxxxx',
    address: 'Jl. Melati 1',
    ktpNo: '3174xxxxxxxxxxxx',
    simNo: 'SIM-123',
    simExpired: '2027-03-15',
    driverCode: null,
    plateNumber: 'B 1793 SCP',
    plateNumberNorm: 'B1793SCP',
    bankAccount: 'BCA 1234567890',
    registrationStatus: 'pending',
    rejectNote: null,
    ktpVerified: true,
    simVerified: false,
    skckVerified: false,
    depositAmount: 1_500_000,
    depositStatus: 'waiting',
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

describe('presentRegistrationSummary / Detail', () => {
  it('maps registration fields to camelCase with ISO timestamps', () => {
    const summary = presentRegistrationSummary(row());
    expect(summary).toMatchObject({
      id: 42,
      name: 'Budi Santoso',
      simExpired: '2027-03-15',
      driverCode: null,
      plateNumber: 'B 1793 SCP',
      registrationStatus: 'pending',
      ktpVerified: true,
      simVerified: false,
      depositAmount: 1_500_000,
      depositStatus: 'waiting',
      createdAt: '2026-07-01T03:00:00.000Z',
    });
    // Internals never leak
    expect(summary).not.toHaveProperty('partnerId');
    expect(summary).not.toHaveProperty('plateNumberNorm');
  });

  it('detail adds deposit decision fields and documents', () => {
    const decidedAt = new Date('2026-07-03T00:00:00Z');
    const documents = [presentDocument(doc(), 'https://s3/signed')];
    const detail = presentRegistrationDetail(
      row({ depositNote: 'Kurang', depositStatus: 'rejected', depositDecidedAt: decidedAt }),
      documents,
    );
    expect(detail.depositNote).toBe('Kurang');
    expect(detail.depositDecidedAt).toBe('2026-07-03T00:00:00.000Z');
    expect(detail.updatedAt).toBe('2026-07-02T04:30:00.000Z');
    expect(detail.documents).toEqual(documents);
  });
});

describe('presentDriverSummary / Detail', () => {
  it('maps an approved driver with joinedAt = createdAt', () => {
    const summary = presentDriverSummary(
      row({ registrationStatus: 'approved', driverCode: 'DRV-000042' }),
    );
    expect(summary).toMatchObject({
      driverCode: 'DRV-000042',
      isActive: true,
      depositAmount: 1_500_000,
      joinedAt: '2026-07-01T03:00:00.000Z',
    });
    expect(summary).not.toHaveProperty('registrationStatus');
  });

  it('detail includes documents', () => {
    const detail = presentDriverDetail(row({ registrationStatus: 'approved' }), []);
    expect(detail.documents).toEqual([]);
    expect(detail.updatedAt).toBe('2026-07-02T04:30:00.000Z');
  });
});

describe('presentResignationSummary / Detail', () => {
  const resigned = row({
    registrationStatus: 'approved',
    driverCode: 'DRV-000042',
    isActive: false,
    resignedAt: new Date('2026-07-10T08:00:00Z'),
    depositReturnStatus: 'waiting',
  });

  it('maps resignation fields with joinedAt and resignedAt', () => {
    const summary = presentResignationSummary(resigned);
    expect(summary).toMatchObject({
      driverCode: 'DRV-000042',
      depositAmount: 1_500_000,
      depositReturnStatus: 'waiting',
      depositReturnDecidedAt: null,
      resignedAt: '2026-07-10T08:00:00.000Z',
      joinedAt: '2026-07-01T03:00:00.000Z',
    });
  });

  it('detail includes deposit status and documents', () => {
    const documents = [presentDocument(doc({ kind: 'deposit_return_proof' }), 'url')];
    const detail = presentResignationDetail(resigned, documents);
    expect(detail.depositStatus).toBe('waiting');
    expect(detail.documents).toHaveLength(1);
    expect(detail.documents[0]!.kind).toBe('deposit_return_proof');
  });
});
