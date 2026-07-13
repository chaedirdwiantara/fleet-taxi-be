import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { driverDocuments, drivers } from '../db/schema';
import { StorageService } from '../storage/storage.service';
import { DriverDocumentRow, DriverDocumentView, presentDocument } from './driver-presenter';
import {
  DRIVER_DOCUMENT_EXTENSIONS,
  DRIVER_MAX_DOCUMENT_BYTES,
  DRIVER_PRESIGN_GET_TTL_SEC,
  DRIVER_PRESIGN_PUT_TTL_SEC,
} from './driver.constants';
import { PresignDriverDocumentDto } from './dto/presign-driver-document.dto';

type Database = DatabaseService['db'];
/** The transaction handle Drizzle passes to `db.transaction(cb)` — same query API. */
type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Driver document storage (KTP/SIM/SKCK scans, deposit proofs), presign →
 * PUT → confirm like checkpoint media. Every document kind is
 * single-instance, so a confirmed upload REPLACES the previous document of
 * the same kind (row deleted, storage object cleaned up best-effort).
 * Bytes never pass through this service in prod: clients upload straight to
 * S3 with presigned PUTs; the dev sink/serve endpoints cover local runs.
 */
@Injectable()
export class DriverDocumentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async presign(
    partnerId: number,
    driverId: number,
    dto: PresignDriverDocumentDto,
  ): Promise<{
    documentId: number;
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
  }> {
    await this.ownedDriverId(partnerId, driverId);

    const ext = DRIVER_DOCUMENT_EXTENSIONS[dto.contentType];
    const storageKey = `partner/${partnerId}/drivers/${driverId}/${dto.kind}/${randomUUID()}.${ext}`;

    const [row] = await this.database.db
      .insert(driverDocuments)
      .values({
        driverId,
        kind: dto.kind,
        storageKey,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
      })
      .returning({ id: driverDocuments.id });

    const uploadUrl = this.storage.isS3()
      ? await this.storage.presignPut(
          storageKey,
          dto.contentType,
          dto.sizeBytes,
          DRIVER_PRESIGN_PUT_TTL_SEC,
        )
      : `/partner/portal/drivers/documents/${row!.id}/upload`;

    return {
      documentId: row!.id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': dto.contentType },
    };
  }

  /** Dev-only upload sink target: persist raw bytes for a pending document row. */
  async storeUploaded(
    partnerId: number,
    documentId: number,
    contentType: string | undefined,
    body: Buffer,
  ): Promise<{ stored: true }> {
    const doc = await this.ownedDocument(partnerId, documentId);
    if (!body?.length) throw new BadRequestException('Body kosong');
    if (body.length > DRIVER_MAX_DOCUMENT_BYTES)
      throw new BadRequestException('File terlalu besar');
    if (contentType !== doc.contentType) {
      throw new BadRequestException(`Content-Type harus ${doc.contentType}`);
    }
    await this.storage.save(doc.storageKey, body);
    return { stored: true };
  }

  /**
   * Marks a pending document `uploaded` after verifying the object exists,
   * then applies the replace semantics: older documents of the same kind on
   * this driver are deleted (rows + best-effort storage objects).
   */
  async confirm(
    partnerId: number,
    driverId: number,
    documentId: number,
  ): Promise<DriverDocumentView> {
    await this.ownedDriverId(partnerId, driverId);
    const doc = await this.ownedDocument(partnerId, documentId);
    if (doc.driverId !== driverId) throw new NotFoundException('Dokumen tidak ditemukan');

    if (doc.status !== 'uploaded') {
      const head = await this.storage.head(doc.storageKey);
      if (!head) throw new BadRequestException('File belum terunggah');
      if (head.size > DRIVER_MAX_DOCUMENT_BYTES)
        throw new BadRequestException('File terlalu besar');
    }

    // Mark uploaded + replace atomically so two concurrent confirms of the
    // same kind can't mutually delete each other's rows.
    const staleKeys = await this.database.db.transaction(async (tx) => {
      if (doc.status !== 'uploaded') {
        await tx
          .update(driverDocuments)
          .set({ status: 'uploaded' })
          .where(eq(driverDocuments.id, documentId));
        doc.status = 'uploaded';
      }

      // Single-instance kinds: the confirmed upload supersedes any previous doc.
      const stale = await tx
        .delete(driverDocuments)
        .where(
          and(
            eq(driverDocuments.driverId, driverId),
            eq(driverDocuments.kind, doc.kind),
            ne(driverDocuments.id, documentId),
          ),
        )
        .returning({ storageKey: driverDocuments.storageKey });
      if (stale.length > 0) {
        await this.resetDerivedState(tx, driverId, doc.kind, 'replace');
      }
      return stale.map((s) => s.storageKey);
    });
    await Promise.all(staleKeys.map((key) => this.storage.delete(key)));

    return this.view(doc);
  }

  async remove(
    partnerId: number,
    driverId: number,
    documentId: number,
  ): Promise<{ deleted: true }> {
    await this.ownedDriverId(partnerId, driverId);
    const [row] = await this.database.db
      .delete(driverDocuments)
      .where(and(eq(driverDocuments.id, documentId), eq(driverDocuments.driverId, driverId)))
      .returning({ storageKey: driverDocuments.storageKey, kind: driverDocuments.kind });
    if (!row) throw new NotFoundException('Dokumen tidak ditemukan');
    await this.resetDerivedState(this.database.db, driverId, row.kind, 'delete');
    await this.storage.delete(row.storageKey);
    return { deleted: true };
  }

  /**
   * A deleted or replaced document invalidates the driver state derived from
   * it (doc-check flags, deposit decisions). One exception: replacing the
   * deposit proof on an already-approved driver keeps depositStatus — that
   * deposit was consumed by the registration approval; a delete still resets.
   */
  private async resetDerivedState(
    ex: Executor,
    driverId: number,
    kind: string,
    event: 'delete' | 'replace',
  ): Promise<void> {
    let patch: Partial<typeof drivers.$inferInsert>;
    if (kind === 'ktp') patch = { ktpVerified: false };
    else if (kind === 'sim') patch = { simVerified: false };
    else if (kind === 'skck') patch = { skckVerified: false };
    else if (kind === 'deposit_proof') {
      if (event === 'replace') {
        const [row] = await ex
          .select({ registrationStatus: drivers.registrationStatus })
          .from(drivers)
          .where(eq(drivers.id, driverId));
        if (row?.registrationStatus === 'approved') return;
      }
      patch = { depositStatus: 'none', depositNote: null, depositDecidedAt: null };
    } else if (kind === 'deposit_return_proof') {
      patch = { depositReturnStatus: 'none', depositReturnDecidedAt: null };
    } else return;
    await ex
      .update(drivers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(drivers.id, driverId));
  }

  /** Loads one document row and its bytes for the dev file GET endpoint. */
  async file(
    partnerId: number,
    documentId: number,
  ): Promise<{ contentType: string; body: Buffer }> {
    const doc = await this.ownedDocument(partnerId, documentId);
    return { contentType: doc.contentType, body: await this.storage.read(doc.storageKey) };
  }

  /** All document views for one driver (uploaded ones carry a viewing URL). */
  async viewsForDriver(driverId: number): Promise<DriverDocumentView[]> {
    const rows = await this.database.db
      .select()
      .from(driverDocuments)
      .where(eq(driverDocuments.driverId, driverId))
      .orderBy(driverDocuments.id);
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** Whether the driver has an uploaded document of this kind (deposit gates). */
  async hasUploaded(driverId: number, kind: string): Promise<boolean> {
    const [row] = await this.database.db
      .select({ id: driverDocuments.id })
      .from(driverDocuments)
      .where(
        and(
          eq(driverDocuments.driverId, driverId),
          eq(driverDocuments.kind, kind),
          eq(driverDocuments.status, 'uploaded'),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Best-effort storage cleanup before a driver row (and its docs) is hard-deleted. */
  async deleteStorageForDriver(driverId: number): Promise<void> {
    const rows = await this.database.db
      .select({ storageKey: driverDocuments.storageKey })
      .from(driverDocuments)
      .where(eq(driverDocuments.driverId, driverId));
    await Promise.all(rows.map((r) => this.storage.delete(r.storageKey)));
  }

  private async view(row: DriverDocumentRow): Promise<DriverDocumentView> {
    if (row.status !== 'uploaded') return presentDocument(row);
    const url = this.storage.isS3()
      ? await this.storage.presignGet(row.storageKey, DRIVER_PRESIGN_GET_TTL_SEC)
      : `/partner/portal/drivers/documents/${row.id}/file`;
    return presentDocument(row, url);
  }

  private async ownedDriverId(partnerId: number, driverId: number): Promise<void> {
    const [row] = await this.database.db
      .select({ id: drivers.id })
      .from(drivers)
      .where(and(eq(drivers.id, driverId), eq(drivers.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Driver tidak ditemukan');
  }

  private async ownedDocument(partnerId: number, documentId: number): Promise<DriverDocumentRow> {
    const [row] = await this.database.db
      .select({ doc: driverDocuments })
      .from(driverDocuments)
      .innerJoin(drivers, eq(driverDocuments.driverId, drivers.id))
      .where(and(eq(driverDocuments.id, documentId), eq(drivers.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Dokumen tidak ditemukan');
    return row.doc;
  }
}
