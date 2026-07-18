import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, isNotNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Pagination } from '../common/util/pagination';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { checkpointMedia, checkpointPoints, checkpoints } from '../db/schema';
import { StorageService } from '../storage/storage.service';
import {
  CHECKPOINT_MAX_MEDIA_BYTES,
  CHECKPOINT_POINT_KEYS,
  CHECKPOINT_POINT_LABELS,
  CHECKPOINT_PRESIGN_GET_TTL_SEC,
  CHECKPOINT_PRESIGN_PUT_TTL_SEC,
  CheckpointPointKey,
  HANDOVER_COMPARISON_PAIR,
  HandoverType,
} from './checkpoint.constants';
import { CompleteCheckpointDto } from './dto/complete-checkpoint.dto';
import { CreateCheckpointDto } from './dto/create-checkpoint.dto';
import { PresignCheckpointMediaDto } from './dto/presign-checkpoint-media.dto';
import { UpdateCheckpointDto } from './dto/update-checkpoint.dto';
import { UpdateCheckpointPointDto } from './dto/update-checkpoint-point.dto';
import { PortalPlatesService } from './portal-plates.service';

type CheckpointRow = typeof checkpoints.$inferSelect;
type MediaRow = typeof checkpointMedia.$inferSelect;

export interface CheckpointMediaView {
  id: number;
  kind: string;
  contentType: string;
  status: string;
  url: string;
}

export interface CheckpointPointView {
  id: number;
  pointKey: string;
  label: string;
  passed: boolean | null;
  note: string | null;
  media: CheckpointMediaView[];
}

export interface CheckpointDetail {
  id: number;
  plateNumber: string;
  plateNumberNorm: string;
  handoverType: string;
  status: string;
  counterpartName: string | null;
  counterpartPhone: string | null;
  odometerKm: number | null;
  batteryPercent: number | null;
  generalNotes: string | null;
  createdAt: string;
  completedAt: string | null;
  points: CheckpointPointView[];
  signatures: CheckpointMediaView[];
}

export interface CheckpointSummary {
  id: number;
  plateNumber: string;
  handoverType: string;
  status: string;
  counterpartName: string | null;
  odometerKm: number | null;
  createdAt: string;
  completedAt: string | null;
  photoCount: number;
}

/**
 * Vehicle-handover inspection documentation, row-scoped to partnerId (always
 * taken from the session — see requirePartner). Media bytes never pass through
 * this service in prod: clients upload straight to S3 with presigned PUTs.
 */
@Injectable()
export class PortalCheckpointsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly plates: PortalPlatesService,
  ) {}

  async list(
    partnerId: number,
    opts: Pagination & {
      plate?: string;
      handoverType?: string;
      status?: string;
      month?: number;
      year?: number;
    },
  ): Promise<{
    data: CheckpointSummary[];
    meta: { page: number; pageSize: number; total: number };
  }> {
    const conditions = [eq(checkpoints.partnerId, partnerId)];
    if (opts.plate) {
      // Partial match so the list-page search finds "2437" in "B2437SNC";
      // norm is [A-Z0-9] only, so no LIKE metacharacters to escape.
      const norm = normalizePlate(opts.plate);
      if (norm) conditions.push(ilike(checkpoints.plateNumberNorm, `%${norm}%`));
    }
    if (opts.handoverType) conditions.push(eq(checkpoints.handoverType, opts.handoverType));
    if (opts.status) conditions.push(eq(checkpoints.status, opts.status));
    if (opts.month && opts.year) {
      // Period bucketing follows the business timezone (brief §7)
      conditions.push(
        sql`extract(month from ${checkpoints.createdAt} at time zone 'Asia/Jakarta') = ${opts.month}`,
        sql`extract(year from ${checkpoints.createdAt} at time zone 'Asia/Jakarta') = ${opts.year}`,
      );
    }
    const where = and(...conditions);

    const [rows, totals] = await Promise.all([
      this.database.db
        .select({
          row: checkpoints,
          // Raw qualified SQL: drizzle renders interpolated columns unqualified
          // inside a select-list subquery, which would collide with the outer table.
          photoCount: sql<number>`(
            select count(*)::int from checkpoint_media cm
            where cm.checkpoint_id = checkpoints.id
              and cm.kind = 'photo'
              and cm.status = 'uploaded'
          )`,
        })
        .from(checkpoints)
        .where(where)
        .orderBy(desc(checkpoints.createdAt))
        .limit(opts.pageSize)
        .offset((opts.page - 1) * opts.pageSize),
      this.database.db
        .select({ total: sql<number>`count(*)::int` })
        .from(checkpoints)
        .where(where),
    ]);

    return {
      data: rows.map(({ row, photoCount }) => ({
        id: row.id,
        plateNumber: row.plateNumber,
        handoverType: row.handoverType,
        status: row.status,
        counterpartName: row.counterpartName,
        odometerKm: row.odometerKm,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        photoCount,
      })),
      meta: { page: opts.page, pageSize: opts.pageSize, total: totals[0]?.total ?? 0 },
    };
  }

  async create(
    partnerId: number,
    userId: number,
    dto: CreateCheckpointDto,
  ): Promise<CheckpointDetail> {
    const norm = normalizePlate(dto.plateNumber);
    if (!norm) throw new BadRequestException('Nomor plat tidak valid');
    const allowed = await this.plates.registeredNorms(partnerId);
    if (!allowed.includes(norm)) {
      throw new BadRequestException('Plat tidak terdaftar — daftarkan plat terlebih dahulu');
    }

    const id = await this.database.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(checkpoints)
        .values({
          partnerId,
          createdBy: userId,
          plateNumber: dto.plateNumber.trim(),
          plateNumberNorm: norm,
          handoverType: dto.handoverType,
          counterpartName: dto.counterpartName?.trim() || null,
          counterpartPhone: dto.counterpartPhone?.trim() || null,
        })
        .returning({ id: checkpoints.id });
      await tx
        .insert(checkpointPoints)
        .values(CHECKPOINT_POINT_KEYS.map((pointKey) => ({ checkpointId: row!.id, pointKey })));
      return row!.id;
    });

    return this.detail(partnerId, id);
  }

  async detail(partnerId: number, id: number): Promise<CheckpointDetail> {
    const row = await this.ownedCheckpoint(partnerId, id);
    const [points, media] = await Promise.all([
      this.database.db.select().from(checkpointPoints).where(eq(checkpointPoints.checkpointId, id)),
      this.database.db
        .select()
        .from(checkpointMedia)
        .where(eq(checkpointMedia.checkpointId, id))
        .orderBy(checkpointMedia.id),
    ]);
    return this.assembleDetail(row, points, media);
  }

  async update(partnerId: number, id: number, dto: UpdateCheckpointDto): Promise<CheckpointDetail> {
    await this.ownedDraft(partnerId, id);
    await this.database.db
      .update(checkpoints)
      .set({
        ...(dto.counterpartName !== undefined && {
          counterpartName: dto.counterpartName.trim() || null,
        }),
        ...(dto.counterpartPhone !== undefined && {
          counterpartPhone: dto.counterpartPhone.trim() || null,
        }),
        ...(dto.odometerKm !== undefined && { odometerKm: dto.odometerKm }),
        ...(dto.batteryPercent !== undefined && { batteryPercent: dto.batteryPercent }),
        ...(dto.generalNotes !== undefined && { generalNotes: dto.generalNotes.trim() || null }),
        updatedAt: new Date(),
      })
      .where(eq(checkpoints.id, id));
    return this.detail(partnerId, id);
  }

  async updatePoint(
    partnerId: number,
    id: number,
    pointKey: string,
    dto: UpdateCheckpointPointDto,
  ): Promise<CheckpointPointView> {
    if (!(CHECKPOINT_POINT_KEYS as readonly string[]).includes(pointKey)) {
      throw new BadRequestException('Titik inspeksi tidak dikenal');
    }
    await this.ownedDraft(partnerId, id);
    const [point] = await this.database.db
      .update(checkpointPoints)
      .set({
        ...(dto.passed !== undefined && { passed: dto.passed }),
        ...(dto.note !== undefined && { note: dto.note.trim() || null }),
        updatedAt: new Date(),
      })
      .where(and(eq(checkpointPoints.checkpointId, id), eq(checkpointPoints.pointKey, pointKey)))
      .returning();
    const media = await this.database.db
      .select()
      .from(checkpointMedia)
      .where(eq(checkpointMedia.pointId, point!.id))
      .orderBy(checkpointMedia.id);
    return {
      id: point!.id,
      pointKey: point!.pointKey,
      label: CHECKPOINT_POINT_LABELS[point!.pointKey as CheckpointPointKey],
      passed: point!.passed,
      note: point!.note,
      media: await Promise.all(media.map((m) => this.mediaView(m))),
    };
  }

  /**
   * Creates a `pending` media row and returns where to PUT the bytes: a real
   * S3 presigned URL in prod, or this API's local upload sink in dev.
   */
  async presignMedia(
    partnerId: number,
    id: number,
    dto: PresignCheckpointMediaDto,
  ): Promise<{
    mediaId: number;
    uploadUrl: string;
    method: 'PUT';
    headers: Record<string, string>;
  }> {
    await this.ownedDraft(partnerId, id);

    let pointId: number | null = null;
    if (dto.kind === 'photo') {
      if (!dto.pointKey) throw new BadRequestException('pointKey wajib untuk foto');
      const [point] = await this.database.db
        .select({ id: checkpointPoints.id })
        .from(checkpointPoints)
        .where(
          and(eq(checkpointPoints.checkpointId, id), eq(checkpointPoints.pointKey, dto.pointKey)),
        );
      if (!point) throw new NotFoundException('Titik inspeksi tidak ditemukan');
      pointId = point.id;
    } else {
      if (dto.pointKey) throw new BadRequestException('pointKey tidak berlaku untuk tanda tangan');
      // Re-signing supersedes the previous signature of the same kind
      const stale = await this.database.db
        .delete(checkpointMedia)
        .where(and(eq(checkpointMedia.checkpointId, id), eq(checkpointMedia.kind, dto.kind)))
        .returning({ storageKey: checkpointMedia.storageKey });
      await Promise.all(stale.map((s) => this.storage.delete(s.storageKey)));
    }

    const ext = dto.contentType === 'image/png' ? 'png' : 'jpg';
    const folder = dto.kind === 'photo' ? dto.pointKey! : 'signatures';
    const storageKey = `partner/${partnerId}/checkpoints/${id}/${folder}/${randomUUID()}.${ext}`;

    const [row] = await this.database.db
      .insert(checkpointMedia)
      .values({
        checkpointId: id,
        pointId,
        kind: dto.kind,
        storageKey,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
      })
      .returning({ id: checkpointMedia.id });

    const uploadUrl = this.storage.isS3()
      ? await this.storage.presignPut(
          storageKey,
          dto.contentType,
          dto.sizeBytes,
          CHECKPOINT_PRESIGN_PUT_TTL_SEC,
        )
      : `/partner/portal/checkpoints/media/${row!.id}/upload`;

    return {
      mediaId: row!.id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': dto.contentType },
    };
  }

  /** Dev-only upload sink target: persist raw bytes for a pending media row. */
  async storeUploadedMedia(
    partnerId: number,
    mediaId: number,
    contentType: string | undefined,
    body: Buffer,
  ): Promise<{ stored: true }> {
    const media = await this.ownedMedia(partnerId, mediaId);
    if (!body?.length) throw new BadRequestException('Body kosong');
    if (body.length > CHECKPOINT_MAX_MEDIA_BYTES)
      throw new BadRequestException('File terlalu besar');
    if (contentType !== media.contentType) {
      throw new BadRequestException(`Content-Type harus ${media.contentType}`);
    }
    await this.storage.save(media.storageKey, body);
    return { stored: true };
  }

  /** Marks a pending media row `uploaded` after verifying the object exists. */
  async confirmMedia(partnerId: number, id: number, mediaId: number): Promise<CheckpointMediaView> {
    await this.ownedDraft(partnerId, id);
    const media = await this.ownedMedia(partnerId, mediaId);
    if (media.checkpointId !== id) throw new NotFoundException('Media tidak ditemukan');

    if (media.status !== 'uploaded') {
      const head = await this.storage.head(media.storageKey);
      if (!head) throw new BadRequestException('File belum terunggah');
      if (head.size > CHECKPOINT_MAX_MEDIA_BYTES)
        throw new BadRequestException('File terlalu besar');
      await this.database.db
        .update(checkpointMedia)
        .set({ status: 'uploaded' })
        .where(eq(checkpointMedia.id, mediaId));
      media.status = 'uploaded';
    }
    return this.mediaView(media);
  }

  async deleteMedia(partnerId: number, id: number, mediaId: number): Promise<{ deleted: true }> {
    await this.ownedDraft(partnerId, id);
    const [row] = await this.database.db
      .delete(checkpointMedia)
      .where(and(eq(checkpointMedia.id, mediaId), eq(checkpointMedia.checkpointId, id)))
      .returning({ storageKey: checkpointMedia.storageKey });
    if (!row) throw new NotFoundException('Media tidak ditemukan');
    await this.storage.delete(row.storageKey);
    return { deleted: true };
  }

  /**
   * Deletes a DRAFT checkpoint (mis-created ones). Completed checkpoints are
   * berita acara — legal handover evidence — and stay immutable/undeletable.
   * Points and media rows go via FK cascade; stored files are cleaned up
   * best-effort (a no-op on S3, where lifecycle rules own object expiry).
   */
  async remove(partnerId: number, id: number): Promise<{ deleted: true }> {
    await this.ownedDraft(partnerId, id);
    const media = await this.database.db
      .select({ storageKey: checkpointMedia.storageKey })
      .from(checkpointMedia)
      .where(eq(checkpointMedia.checkpointId, id));
    await this.database.db
      .delete(checkpoints)
      .where(and(eq(checkpoints.id, id), eq(checkpoints.partnerId, partnerId)));
    await Promise.all(media.map((m) => this.storage.delete(m.storageKey)));
    return { deleted: true };
  }

  async complete(
    partnerId: number,
    id: number,
    dto: CompleteCheckpointDto,
  ): Promise<CheckpointDetail> {
    await this.ownedDraft(partnerId, id);

    const [points, media] = await Promise.all([
      this.database.db.select().from(checkpointPoints).where(eq(checkpointPoints.checkpointId, id)),
      this.database.db
        .select()
        .from(checkpointMedia)
        .where(and(eq(checkpointMedia.checkpointId, id), eq(checkpointMedia.status, 'uploaded'))),
    ]);

    const details: Array<{ field: string; message: string }> = [];
    const photosByPoint = new Map<number, number>();
    for (const m of media) {
      if (m.kind === 'photo' && m.pointId != null) {
        photosByPoint.set(m.pointId, (photosByPoint.get(m.pointId) ?? 0) + 1);
      }
    }
    for (const p of points) {
      const label = CHECKPOINT_POINT_LABELS[p.pointKey as CheckpointPointKey] ?? p.pointKey;
      if (p.passed == null) details.push({ field: p.pointKey, message: `${label}: belum dinilai` });
      if (!photosByPoint.get(p.id))
        details.push({ field: p.pointKey, message: `${label}: belum ada foto` });
    }
    for (const kind of ['signature_partner', 'signature_counterpart'] as const) {
      if (!media.some((m) => m.kind === kind)) {
        details.push({
          field: kind,
          message:
            kind === 'signature_partner'
              ? 'Tanda tangan petugas partner belum ada'
              : 'Tanda tangan pihak penerima/penyerah belum ada',
        });
      }
    }
    if (details.length) {
      throw new BadRequestException({ message: 'Checkpoint belum lengkap', details });
    }

    await this.database.db
      .update(checkpoints)
      .set({
        status: 'completed',
        odometerKm: dto.odometerKm,
        batteryPercent: dto.batteryPercent,
        generalNotes: dto.generalNotes?.trim() || null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(checkpoints.id, id));

    return this.detail(partnerId, id);
  }

  /**
   * The latest completed paired delivery checkpoint for the same plate, to
   * compare a return against. Null when the checkpoint isn't a return type or
   * no paired delivery exists.
   */
  async comparison(partnerId: number, id: number): Promise<CheckpointDetail | null> {
    const row = await this.ownedCheckpoint(partnerId, id);
    const pairedType = HANDOVER_COMPARISON_PAIR[row.handoverType as HandoverType];
    if (!pairedType) return null;

    const cutoff = row.completedAt ?? new Date();
    const [prev] = await this.database.db
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.partnerId, partnerId),
          eq(checkpoints.plateNumberNorm, row.plateNumberNorm),
          eq(checkpoints.handoverType, pairedType),
          eq(checkpoints.status, 'completed'),
          isNotNull(checkpoints.completedAt),
          lt(checkpoints.completedAt, cutoff),
        ),
      )
      .orderBy(desc(checkpoints.completedAt))
      .limit(1);

    return prev ? this.detail(partnerId, prev.id) : null;
  }

  /** Loads one media row and its bytes for the dev media GET endpoint. */
  async mediaFile(
    partnerId: number,
    mediaId: number,
  ): Promise<{ contentType: string; body: Buffer }> {
    const media = await this.ownedMedia(partnerId, mediaId);
    return { contentType: media.contentType, body: await this.storage.read(media.storageKey) };
  }

  /** Everything the PDF needs, media as raw buffers. */
  async detailWithBuffers(
    partnerId: number,
    id: number,
  ): Promise<{
    detail: CheckpointDetail;
    buffers: Map<number, Buffer>;
  }> {
    const detail = await this.detail(partnerId, id);
    const rows = await this.database.db
      .select()
      .from(checkpointMedia)
      .where(and(eq(checkpointMedia.checkpointId, id), eq(checkpointMedia.status, 'uploaded')));
    const buffers = new Map<number, Buffer>();
    await Promise.all(
      rows.map(async (m) => {
        try {
          buffers.set(m.id, await this.storage.read(m.storageKey));
        } catch {
          // A missing object shouldn't kill the whole report
        }
      }),
    );
    return { detail, buffers };
  }

  private async ownedCheckpoint(partnerId: number, id: number): Promise<CheckpointRow> {
    const [row] = await this.database.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.id, id), eq(checkpoints.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Checkpoint tidak ditemukan');
    return row;
  }

  private async ownedDraft(partnerId: number, id: number): Promise<CheckpointRow> {
    const row = await this.ownedCheckpoint(partnerId, id);
    if (row.status !== 'draft') {
      throw new ConflictException('Checkpoint sudah diselesaikan dan tidak bisa diubah');
    }
    return row;
  }

  private async ownedMedia(partnerId: number, mediaId: number): Promise<MediaRow> {
    const [row] = await this.database.db
      .select({ media: checkpointMedia })
      .from(checkpointMedia)
      .innerJoin(checkpoints, eq(checkpointMedia.checkpointId, checkpoints.id))
      .where(and(eq(checkpointMedia.id, mediaId), eq(checkpoints.partnerId, partnerId)));
    if (!row) throw new NotFoundException('Media tidak ditemukan');
    return row.media;
  }

  private async mediaView(m: MediaRow): Promise<CheckpointMediaView> {
    return {
      id: m.id,
      kind: m.kind,
      contentType: m.contentType,
      status: m.status,
      url: this.storage.isS3()
        ? await this.storage.presignGet(m.storageKey, CHECKPOINT_PRESIGN_GET_TTL_SEC)
        : `/partner/portal/checkpoints/media/${m.id}/file`,
    };
  }

  private async assembleDetail(
    row: CheckpointRow,
    points: (typeof checkpointPoints.$inferSelect)[],
    media: MediaRow[],
  ): Promise<CheckpointDetail> {
    const mediaViews = new Map<number, CheckpointMediaView>();
    for (const m of media) mediaViews.set(m.id, await this.mediaView(m));

    const byPoint = new Map<number, CheckpointMediaView[]>();
    const signatures: CheckpointMediaView[] = [];
    for (const m of media) {
      const view = mediaViews.get(m.id)!;
      if (m.pointId != null) {
        const list = byPoint.get(m.pointId) ?? [];
        list.push(view);
        byPoint.set(m.pointId, list);
      } else {
        signatures.push(view);
      }
    }

    const pointByKey = new Map(points.map((p) => [p.pointKey, p]));
    return {
      id: row.id,
      plateNumber: row.plateNumber,
      plateNumberNorm: row.plateNumberNorm,
      handoverType: row.handoverType,
      status: row.status,
      counterpartName: row.counterpartName,
      counterpartPhone: row.counterpartPhone,
      odometerKm: row.odometerKm,
      batteryPercent: row.batteryPercent,
      generalNotes: row.generalNotes,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      // template order, not row order
      points: CHECKPOINT_POINT_KEYS.flatMap((key) => {
        const p = pointByKey.get(key);
        if (!p) return [];
        return [
          {
            id: p.id,
            pointKey: p.pointKey,
            label: CHECKPOINT_POINT_LABELS[key],
            passed: p.passed,
            note: p.note,
            media: byPoint.get(p.id) ?? [],
          },
        ];
      }),
      signatures,
    };
  }
}
