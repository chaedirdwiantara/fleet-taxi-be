import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { SessionUser } from '../auth/session.types';
import { DatabaseService } from '../db/database.service';
import { rentalPaymentProofs, rentals } from '../db/schema';
import { StorageService } from '../storage/storage.service';
import { presentProof, RentalPaymentProofDto, RentalProofRow } from './rental-presenter';
import {
  RENTAL_MAX_PROOF_BYTES,
  RENTAL_MAX_PROOFS,
  RENTAL_PROOF_DRAFT_TTL_MS,
  RENTAL_PROOF_EXTENSIONS,
  RENTAL_PROOF_PRESIGN_GET_TTL_SEC,
  RENTAL_PROOF_PRESIGN_PUT_TTL_SEC,
} from './rental-proof.constants';
import { PresignRentalProofDto } from './dto/presign-rental-proof.dto';

/** Drizzle transaction handle, as handed to `db.transaction(async (tx) => …)`. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/**
 * Payment evidence for rental transactions: presign → PUT → confirm, the same
 * flow as driver documents and checkpoint media. Bytes never pass through this
 * service in prod — clients upload straight to S3 with presigned PUTs; the
 * dev sink/serve endpoints cover local runs.
 *
 * A proof is created as a partner-owned DRAFT (`rentalId` null) so the
 * add-rental form can collect evidence before the rental row exists; it is
 * attached to a rental when that rental is written. Every read and write is
 * scoped by the session's partnerId — never by a client-sent scope.
 */
@Injectable()
export class RentalPaymentProofsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async presign(
    user: SessionUser,
    partnerId: number,
    dto: PresignRentalProofDto,
  ): Promise<{
    proofId: number;
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
  }> {
    await this.sweepStaleDrafts(partnerId);

    const ext = RENTAL_PROOF_EXTENSIONS[dto.contentType];
    const storageKey = `partner/${partnerId}/rentals/proofs/${randomUUID()}.${ext}`;

    const [row] = await this.database.db
      .insert(rentalPaymentProofs)
      .values({
        partnerId,
        rentalId: null,
        storageKey,
        fileName: dto.fileName.trim(),
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
        // Uploader identity is snapshotted, never resolved through a FK.
        uploadedByUserId: user.id,
        uploadedByName: user.fullName,
        uploadedByEmail: user.email,
      })
      .returning({ id: rentalPaymentProofs.id });

    const uploadUrl = this.storage.isS3()
      ? await this.storage.presignPut(
          storageKey,
          dto.contentType,
          dto.sizeBytes,
          RENTAL_PROOF_PRESIGN_PUT_TTL_SEC,
        )
      : `/partner/portal/rentals/proofs/${row!.id}/upload`;

    return {
      proofId: row!.id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': dto.contentType },
    };
  }

  /** Dev-only upload sink target: persist raw bytes for a pending proof row. */
  async storeUploaded(
    partnerId: number,
    proofId: number,
    contentType: string | undefined,
    body: Buffer,
  ): Promise<{ stored: true }> {
    const proof = await this.ownedProof(partnerId, proofId);
    if (!body?.length) throw new BadRequestException('Body kosong');
    if (body.length > RENTAL_MAX_PROOF_BYTES) throw new BadRequestException('File terlalu besar');
    if (contentType !== proof.contentType) {
      throw new BadRequestException(`Content-Type harus ${proof.contentType}`);
    }
    await this.storage.save(proof.storageKey, body);
    return { stored: true };
  }

  /** Marks a pending proof `uploaded` after verifying the object really exists. */
  async confirm(partnerId: number, proofId: number): Promise<RentalPaymentProofDto> {
    const proof = await this.ownedProof(partnerId, proofId);

    if (proof.status !== 'uploaded') {
      const head = await this.storage.head(proof.storageKey);
      if (!head) throw new BadRequestException('File belum terunggah');
      if (head.size > RENTAL_MAX_PROOF_BYTES) throw new BadRequestException('File terlalu besar');
      await this.database.db
        .update(rentalPaymentProofs)
        .set({ status: 'uploaded' })
        .where(eq(rentalPaymentProofs.id, proofId));
      proof.status = 'uploaded';
    }

    return this.view(proof);
  }

  /**
   * Deletes one proof. Refused when it is the last evidence of a rental that
   * is still marked paid — otherwise a paid row could be stripped of the
   * justification that this feature exists to guarantee.
   */
  async remove(partnerId: number, proofId: number): Promise<{ deleted: true }> {
    const proof = await this.ownedProof(partnerId, proofId);

    if (proof.rentalId != null) {
      const [rental] = await this.database.db
        .select({ paymentStatus: rentals.paymentStatus })
        .from(rentals)
        .where(eq(rentals.id, proof.rentalId));
      if (rental?.paymentStatus === 'Sudah Dibayar') {
        const remaining = await this.countAttached(proof.rentalId, proofId);
        if (remaining === 0) {
          throw new BadRequestException(
            'Bukti terakhir tidak bisa dihapus selama transaksi berstatus Sudah Dibayar. Ubah status ke Belum Dibayar terlebih dahulu.',
          );
        }
      }
    }

    await this.database.db.delete(rentalPaymentProofs).where(eq(rentalPaymentProofs.id, proofId));
    await this.storage.delete(proof.storageKey);
    return { deleted: true };
  }

  /** Loads one proof row and its bytes for the dev file GET endpoint. */
  async file(partnerId: number, proofId: number): Promise<{ contentType: string; body: Buffer }> {
    const proof = await this.ownedProof(partnerId, proofId);
    return { contentType: proof.contentType, body: await this.storage.read(proof.storageKey) };
  }

  /**
   * Attaches confirmed proofs to a rental inside the caller's transaction, so
   * a rental never becomes paid without its evidence landing in the same
   * commit. Ids already attached to THIS rental are accepted as a no-op, which
   * makes repeated saves of an unchanged form idempotent.
   *
   * Returns the resulting attached count so the caller can enforce the
   * "paid ⇒ at least one proof" rule on the post-attach state.
   */
  async attach(tx: Tx, partnerId: number, rentalId: number, proofIds: number[]): Promise<number> {
    const wanted = [...new Set(proofIds)];

    if (wanted.length > 0) {
      const rows = await tx
        .select({
          id: rentalPaymentProofs.id,
          rentalId: rentalPaymentProofs.rentalId,
          status: rentalPaymentProofs.status,
        })
        .from(rentalPaymentProofs)
        .where(
          and(
            inArray(rentalPaymentProofs.id, wanted),
            eq(rentalPaymentProofs.partnerId, partnerId),
          ),
        );

      if (rows.length !== wanted.length) {
        throw new NotFoundException('Bukti pembayaran tidak ditemukan');
      }
      if (rows.some((r) => r.status !== 'uploaded')) {
        throw new BadRequestException('Ada bukti pembayaran yang belum selesai diunggah');
      }
      // A proof belongs to exactly one rental; reusing another rental's
      // evidence would silently duplicate it across transactions.
      if (rows.some((r) => r.rentalId != null && r.rentalId !== rentalId)) {
        throw new BadRequestException(
          'Ada bukti pembayaran yang sudah terpakai di transaksi rental lain',
        );
      }

      const fresh = rows.filter((r) => r.rentalId == null).map((r) => r.id);
      if (fresh.length > 0) {
        await tx
          .update(rentalPaymentProofs)
          .set({ rentalId })
          .where(inArray(rentalPaymentProofs.id, fresh));
      }
    }

    const attached = await tx
      .select({ id: rentalPaymentProofs.id })
      .from(rentalPaymentProofs)
      .where(eq(rentalPaymentProofs.rentalId, rentalId));

    if (attached.length > RENTAL_MAX_PROOFS) {
      throw new BadRequestException(
        `Maksimal ${RENTAL_MAX_PROOFS} bukti pembayaran per transaksi rental.`,
      );
    }
    return attached.length;
  }

  /**
   * Proof views for many rentals in ONE query (the monthly list can hold
   * dozens of rows — a per-row fetch would be an N+1). Presigned GET URLs are
   * minted per call and deliberately short-lived.
   */
  async viewsForRentals(rentalIds: number[]): Promise<Map<number, RentalPaymentProofDto[]>> {
    const byRental = new Map<number, RentalPaymentProofDto[]>();
    if (rentalIds.length === 0) return byRental;

    const rows = await this.database.db
      .select()
      .from(rentalPaymentProofs)
      .where(inArray(rentalPaymentProofs.rentalId, rentalIds))
      .orderBy(rentalPaymentProofs.id);

    const views = await Promise.all(rows.map((row) => this.view(row)));
    rows.forEach((row, i) => {
      const list = byRental.get(row.rentalId!) ?? [];
      list.push(views[i]!);
      byRental.set(row.rentalId!, list);
    });
    return byRental;
  }

  /** Proof views for a single rental (create/update/status responses). */
  async viewsForRental(rentalId: number): Promise<RentalPaymentProofDto[]> {
    return (await this.viewsForRentals([rentalId])).get(rentalId) ?? [];
  }

  // ---- internals -------------------------------------------------------------

  private async view(row: RentalProofRow): Promise<RentalPaymentProofDto> {
    if (row.status !== 'uploaded') return presentProof(row);
    const url = this.storage.isS3()
      ? await this.storage.presignGet(row.storageKey, RENTAL_PROOF_PRESIGN_GET_TTL_SEC)
      : `/partner/portal/rentals/proofs/${row.id}/file`;
    return presentProof(row, url);
  }

  /** Number of proofs attached to a rental, optionally excluding one id. */
  private async countAttached(rentalId: number, excludeId?: number): Promise<number> {
    const rows = await this.database.db
      .select({ id: rentalPaymentProofs.id })
      .from(rentalPaymentProofs)
      .where(eq(rentalPaymentProofs.rentalId, rentalId));
    return rows.filter((r) => r.id !== excludeId).length;
  }

  private async ownedProof(partnerId: number, proofId: number): Promise<RentalProofRow> {
    const [row] = await this.database.db
      .select()
      .from(rentalPaymentProofs)
      .where(
        and(eq(rentalPaymentProofs.id, proofId), eq(rentalPaymentProofs.partnerId, partnerId)),
      );
    if (!row) throw new NotFoundException('Bukti pembayaran tidak ditemukan');
    return row;
  }

  /**
   * Drops this partner's never-attached drafts older than the TTL — the
   * residue of add-rental forms abandoned after uploading. Piggy-backing on
   * presign keeps it self-limiting and cron-free; failures are non-fatal
   * because a leftover object is far less bad than a broken upload.
   */
  private async sweepStaleDrafts(partnerId: number): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - RENTAL_PROOF_DRAFT_TTL_MS);
      const stale = await this.database.db
        .delete(rentalPaymentProofs)
        .where(
          and(
            eq(rentalPaymentProofs.partnerId, partnerId),
            isNull(rentalPaymentProofs.rentalId),
            lt(rentalPaymentProofs.uploadedAt, cutoff),
          ),
        )
        .returning({ storageKey: rentalPaymentProofs.storageKey });
      await Promise.all(stale.map((s) => this.storage.delete(s.storageKey)));
    } catch {
      // Best-effort housekeeping — never block a legitimate upload.
    }
  }
}
