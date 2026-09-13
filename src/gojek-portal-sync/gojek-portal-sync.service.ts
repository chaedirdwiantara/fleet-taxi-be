import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, count, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { Paginated } from '../common/dto/paginated.dto';
import { Pagination } from '../common/util/pagination';
import { DatabaseService } from '../db/database.service';
import { gojekPortalSyncRuns, gojekPortalSyncSettings, users } from '../db/schema';
import { detectKind } from '../import/file-reader';
import { ImportService } from '../import/import.service';
import { StorageService } from '../storage/storage.service';
import { CredentialCipher, CredentialCipherError } from './credential-cipher';
import { UpdateGojekPortalSyncSettingsDto } from './dto/gojek-portal-sync.dto';
import { GojekFleetPartnerClient, GojekPortalError } from './gojek-fleet-partner.client';
import {
  GojekPortalSyncRunDto,
  GojekPortalSyncSettingsDto,
  GojekPortalSyncStatusDto,
  toRunDto,
  toSettingsDto,
} from './gojek-portal-sync-presenter';
import { GOJEK_PORTAL_SYNC_QUEUE, SyncRunJobData } from './gojek-portal-sync.types';
import {
  clampLookback,
  DateRange,
  decideSchedule,
  defaultRange,
  InvalidRangeError,
  isValidRunAt,
  MAX_SCHEDULED_ATTEMPTS_PER_DAY,
  nextScheduledAt,
  ScheduleDecision,
  splitByMonth,
  SyncTrigger,
  utcBounds,
  validateRange,
  wibClock,
} from './sync-schedule';

/** Activity-log action for a failed pull — surfaces in /admin/logs (super_admin). */
export const SYNC_FAILURE_ACTION = 'sync.gojek_portal.failure';

/** A run still "running" after this long lost its worker (restart/crash). */
const STALE_RUN_MS = 45 * 60 * 1000;
/** How long a run waits for its queued imports before giving up. */
const IMPORT_WAIT_MS = 15 * 60 * 1000;
const IMPORT_POLL_MS = 1_000;

const MONTHS_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

type SettingsRow = typeof gojekPortalSyncSettings.$inferSelect;
type RunRow = typeof gojekPortalSyncRuns.$inferSelect;

/**
 * Automatic Gojek report sync: login to the Fleet Partner Portal, request the
 * "Transaction History for Reconciliation" report for a WIB date range,
 * download it, and hand it to the SAME import pipeline a manual upload uses
 * (ImportService → IMPORT_QUEUE), one batch per month in the range.
 *
 * Schedule: a BullMQ repeatable `tick` fires every 30 minutes; the daily run
 * starts on the first tick past the configured time and is retried on later
 * ticks while it keeps failing (max MAX_SCHEDULED_ATTEMPTS_PER_DAY). Default
 * range = yesterday going back `lookbackDays`; today is never pulled because
 * the portal's data for the running day is incomplete.
 */
@Injectable()
export class GojekPortalSyncService {
  private readonly logger = new Logger(GojekPortalSyncService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly cipher: CredentialCipher,
    private readonly client: GojekFleetPartnerClient,
    private readonly importService: ImportService,
    private readonly storage: StorageService,
    private readonly activityLog: ActivityLogService,
    @InjectQueue(GOJEK_PORTAL_SYNC_QUEUE) private readonly queue: Queue,
  ) {}

  /* ===================== settings ===================== */

  async getSettings(): Promise<GojekPortalSyncSettingsDto> {
    const row = await this.settingsRow();
    const updatedByName = row?.updatedBy == null ? null : await this.userName(row.updatedBy);
    return toSettingsDto(row, this.cipher.isConfigured(), updatedByName);
  }

  /**
   * Save account + schedule. An empty password keeps the stored digest; a new
   * one is digested (base64(md5)) and encrypted before it touches the DB —
   * the raw password is never persisted or logged.
   */
  async saveSettings(
    dto: UpdateGojekPortalSyncSettingsDto,
    adminId: number,
  ): Promise<GojekPortalSyncSettingsDto> {
    if (!isValidRunAt(dto.runAt)) {
      throw new BadRequestException('Jam jadwal harus kelipatan 30 menit (HH:00 / HH:30 WIB).');
    }
    const current = await this.settingsRow();
    const email = dto.email.trim().toLowerCase();
    const password = dto.password ?? '';

    const patch: Partial<SettingsRow> = {
      email,
      isEnabled: dto.isEnabled,
      runAt: dto.runAt,
      lookbackDays: clampLookback(dto.lookbackDays),
      updatedBy: adminId,
      updatedAt: new Date(),
    };

    if (password !== '') {
      this.requireCipher();
      patch.passwordDigestEnc = this.cipher.encrypt(
        GojekFleetPartnerClient.passwordDigest(password),
      );
      patch.lastVerifiedAt = null; // not yet proven against the portal
    } else if (!current?.passwordDigestEnc) {
      if (dto.isEnabled) {
        throw new BadRequestException(
          'Kata sandi portal belum diisi — sinkronisasi belum bisa diaktifkan.',
        );
      }
    } else if (current.email !== email) {
      patch.lastVerifiedAt = null; // a different account invalidates the old check
    }

    const { db } = this.database;
    if (current) {
      await db
        .update(gojekPortalSyncSettings)
        .set(patch)
        .where(eq(gojekPortalSyncSettings.id, current.id));
    } else {
      await db.insert(gojekPortalSyncSettings).values({
        email,
        passwordDigestEnc: patch.passwordDigestEnc ?? null,
        isEnabled: patch.isEnabled!,
        runAt: patch.runAt!,
        lookbackDays: patch.lookbackDays!,
        lastVerifiedAt: null,
        updatedBy: adminId,
      });
    }
    return this.getSettings();
  }

  /**
   * Login only. Without arguments the stored account is used and a success is
   * remembered as `lastVerifiedAt`; with a typed password the form values are
   * tested as-is and nothing is stored.
   */
  async testConnection(input: {
    email?: string;
    password?: string;
  }): Promise<{ email: string; verifiedAt: string | null }> {
    const settings = await this.settingsRow();
    const email = (input.email?.trim() || settings?.email || '').toLowerCase();
    const typedPassword = input.password ?? '';
    const digest =
      typedPassword !== ''
        ? GojekFleetPartnerClient.passwordDigest(typedPassword)
        : this.storedDigest(settings);
    if (email === '' || digest === '') {
      throw new BadRequestException('Email dan kata sandi portal harus diisi dulu.');
    }

    try {
      await this.client.login(email, digest);
    } catch (err) {
      throw toHttpError(err);
    }

    const usesStoredAccount = !!settings && settings.email === email && typedPassword === '';
    if (!usesStoredAccount) return { email, verifiedAt: null };

    const verifiedAt = new Date();
    await this.database.db
      .update(gojekPortalSyncSettings)
      .set({ lastVerifiedAt: verifiedAt })
      .where(eq(gojekPortalSyncSettings.id, settings.id));
    return { email, verifiedAt: verifiedAt.toISOString() };
  }

  /* ===================== status & history ===================== */

  async getStatus(now = new Date()): Promise<GojekPortalSyncStatusDto> {
    const settings = await this.settingsRow();
    const { db } = this.database;
    const [lastRun] = await db
      .select()
      .from(gojekPortalSyncRuns)
      .orderBy(desc(gojekPortalSyncRuns.startedAt), desc(gojekPortalSyncRuns.id))
      .limit(1);
    const [lastSuccess] = await db
      .select()
      .from(gojekPortalSyncRuns)
      .where(eq(gojekPortalSyncRuns.status, 'success'))
      .orderBy(desc(gojekPortalSyncRuns.startedAt), desc(gojekPortalSyncRuns.id))
      .limit(1);
    const running = await this.runningRun();
    const todayStatuses = await this.scheduledStatusesToday(now);

    const isEnabled = settings?.isEnabled ?? false;
    const doneToday =
      todayStatuses.includes('success') || todayStatuses.length >= MAX_SCHEDULED_ATTEMPTS_PER_DAY;
    const dtos = await this.toRunDtos([lastRun, lastSuccess, running].filter(isRow));
    const dtoById = new Map(dtos.map((d) => [d.id, d]));

    return {
      isEnabled,
      hasCredentials: hasCredentials(settings),
      encryptionConfigured: this.cipher.isConfigured(),
      lastVerifiedAt: settings?.lastVerifiedAt?.toISOString() ?? null,
      lastSuccess: lastSuccess ? (dtoById.get(lastSuccess.id) ?? null) : null,
      lastRun: lastRun ? (dtoById.get(lastRun.id) ?? null) : null,
      runningRun: running ? (dtoById.get(running.id) ?? null) : null,
      todayScheduledAttempts: todayStatuses.length,
      nextScheduledAt:
        isEnabled && settings
          ? nextScheduledAt(now, settings.runAt, doneToday).toISOString()
          : null,
    };
  }

  async listRuns(page: Pagination): Promise<Paginated<GojekPortalSyncRunDto>> {
    const { db } = this.database;
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(gojekPortalSyncRuns)
        .orderBy(desc(gojekPortalSyncRuns.startedAt), desc(gojekPortalSyncRuns.id))
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize),
      db.select({ total: count() }).from(gojekPortalSyncRuns),
    ]);
    return {
      data: await this.toRunDtos(rows),
      meta: { page: page.page, pageSize: page.pageSize, total: totals[0]?.total ?? 0 },
    };
  }

  async getRun(id: number): Promise<GojekPortalSyncRunDto> {
    const row = await this.runRow(id);
    if (!row) throw new NotFoundException(`Sync run ${id} not found`);
    return (await this.toRunDtos([row]))[0]!;
  }

  /* ===================== triggering ===================== */

  /** "Jalankan sekarang": validate, record the run, and queue it (never inline). */
  async requestRun(
    adminId: number,
    range: { dateFrom?: string; dateTo?: string },
    now = new Date(),
  ): Promise<GojekPortalSyncRunDto> {
    await this.reapStaleRuns(now);
    const settings = await this.settingsRow();
    if (!hasCredentials(settings)) {
      throw new BadRequestException(
        'Akun portal Gojek belum diatur. Isi email & kata sandi di pengaturan sinkronisasi.',
      );
    }
    this.requireCipher();
    const running = await this.runningRun();
    if (running) {
      throw new ConflictException(
        `Sinkronisasi lain masih berjalan (dimulai ${wibClock(running.startedAt).time} WIB). Tunggu sampai selesai.`,
      );
    }

    let resolved: DateRange;
    try {
      resolved =
        range.dateFrom || range.dateTo
          ? validateRange(range.dateFrom ?? '', range.dateTo ?? '', now)
          : defaultRange(settings.lookbackDays, now);
    } catch (err) {
      if (err instanceof InvalidRangeError) throw new BadRequestException(err.message);
      throw err;
    }

    const run = await this.createRun('manual', resolved, adminId, now);
    await this.queue.add('run', { runId: run.id } satisfies SyncRunJobData, {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    return (await this.toRunDtos([run]))[0]!;
  }

  /**
   * The 30-minute tick. Decides on its own whether today's scheduled run is
   * due (see decideSchedule) and, if so, executes it right here.
   */
  async runScheduledTick(now = new Date()): Promise<ScheduleDecision & { runId?: number }> {
    await this.reapStaleRuns(now);
    const settings = await this.settingsRow();
    if (!settings?.isEnabled) return { due: false, reason: 'Sinkronisasi terjadwal nonaktif.' };
    if (!hasCredentials(settings)) return { due: false, reason: 'Akun portal belum diatur.' };
    if (!this.cipher.isConfigured()) {
      return { due: false, reason: 'GOJEK_PORTAL_ENCRYPTION_KEY belum diatur di server.' };
    }
    if (await this.runningRun()) return { due: false, reason: 'Masih ada proses yang berjalan.' };

    const decision = decideSchedule(
      wibClock(now).time,
      settings.runAt,
      await this.scheduledStatusesToday(now),
    );
    if (!decision.due) return decision;

    const run = await this.createRun(
      'schedule',
      defaultRange(settings.lookbackDays, now),
      null,
      now,
    );
    this.logger.log(`scheduled sync run ${run.id}: ${decision.reason}`);
    await this.execute(run.id);
    return { ...decision, runId: run.id };
  }

  /* ===================== execution ===================== */

  /**
   * One full pull for an existing `running` run. Never throws: the outcome is
   * written to the run (success/failed + operator-facing message) and a
   * failure is pushed to the activity log for super_admins.
   */
  async execute(runId: number): Promise<void> {
    const run = await this.runRow(runId);
    if (!run || run.status !== 'running') return; // reaped, or already finished
    const range: DateRange = { dateFrom: run.dateFrom, dateTo: run.dateTo };

    try {
      const settings = await this.settingsRow();
      if (!hasCredentials(settings)) {
        throw new GojekPortalError('login_rejected', 'Akun portal Gojek belum diatur.');
      }
      const token = await this.client.login(settings.email!, this.storedDigest(settings));

      const { fromUtc, toUtc } = utcBounds(range);
      const reportId = await this.client.requestExport(token, fromUtc, toUtc);
      await this.updateRun(runId, { reportId });

      const url = await this.client.waitForReport(token, reportId);
      const downloaded = await this.client.download(token, url);

      const kind = detectKind(downloaded.filename) ?? 'xlsx';
      const filename = buildFilename(range, runId, kind);
      const fileKey = `import/fleet-monitoring/${range.dateTo.slice(0, 7)}/${filename}`;
      await this.storage.save(fileKey, downloaded.buffer);
      await this.updateRun(runId, { filename, fileKey });

      const importIds: number[] = [];
      for (const slice of splitByMonth(range)) {
        const { importId } = await this.importService.createPortalImport({
          fileKey,
          filename,
          kind,
          periodYear: slice.year,
          periodMonth: slice.month,
          dateFrom: slice.dateFrom,
          dateTo: slice.dateTo,
          syncRunId: runId,
        });
        importIds.push(importId);
      }
      await this.updateRun(runId, { importIds });

      const states = await this.waitForImports(importIds);
      const failed = states.find((s) => s.status === 'failed');
      if (failed) {
        throw new GojekPortalError(
          'bad_response',
          `Import batch #${failed.id} gagal: ${failed.error ?? 'lihat log server'}.`,
        );
      }
      const importedRows = states.reduce((sum, s) => sum + (s.totalRows ?? 0), 0);
      const skippedRows = states.reduce((sum, s) => sum + (s.skippedRows ?? 0), 0);

      await this.updateRun(runId, {
        status: 'success',
        importedRows,
        skippedRows,
        message: summaryMessage(range, importedRows, skippedRows),
        finishedAt: new Date(),
      });
      this.logger.log(`sync run ${runId} ok: ${importedRows} rows (${skippedRows} skipped)`);
    } catch (err) {
      const message = operatorMessage(err);
      this.logger.error(`sync run ${runId} failed: ${message}`);
      await this.updateRun(runId, { status: 'failed', message, finishedAt: new Date() });
      await this.notifyFailure(runId, run, message);
    }
  }

  /* ===================== internals ===================== */

  private async settingsRow(): Promise<SettingsRow | null> {
    const [row] = await this.database.db
      .select()
      .from(gojekPortalSyncSettings)
      .orderBy(gojekPortalSyncSettings.id)
      .limit(1);
    return row ?? null;
  }

  private async runRow(id: number): Promise<RunRow | null> {
    const [row] = await this.database.db
      .select()
      .from(gojekPortalSyncRuns)
      .where(eq(gojekPortalSyncRuns.id, id));
    return row ?? null;
  }

  private async runningRun(): Promise<RunRow | null> {
    const [row] = await this.database.db
      .select()
      .from(gojekPortalSyncRuns)
      .where(eq(gojekPortalSyncRuns.status, 'running'))
      .orderBy(desc(gojekPortalSyncRuns.startedAt))
      .limit(1);
    return row ?? null;
  }

  /** Statuses of today's (WIB) scheduled runs, oldest first. */
  private async scheduledStatusesToday(now: Date): Promise<string[]> {
    const today = wibClock(now).date;
    const { fromUtc, toUtc } = utcBounds({ dateFrom: today, dateTo: today });
    const rows = await this.database.db
      .select({ status: gojekPortalSyncRuns.status })
      .from(gojekPortalSyncRuns)
      .where(
        and(
          eq(gojekPortalSyncRuns.trigger, 'schedule'),
          gte(gojekPortalSyncRuns.startedAt, fromUtc),
          lt(gojekPortalSyncRuns.startedAt, new Date(toUtc.getTime() + 1)),
        ),
      )
      .orderBy(gojekPortalSyncRuns.startedAt);
    return rows.map((r) => r.status);
  }

  private async createRun(
    trigger: SyncTrigger,
    range: DateRange,
    triggeredBy: number | null,
    now: Date,
  ): Promise<RunRow> {
    const [row] = await this.database.db
      .insert(gojekPortalSyncRuns)
      .values({
        trigger,
        status: 'running',
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        triggeredBy,
        startedAt: now,
      })
      .returning();
    return row!;
  }

  private async updateRun(id: number, patch: Partial<RunRow>): Promise<void> {
    await this.database.db
      .update(gojekPortalSyncRuns)
      .set(patch)
      .where(eq(gojekPortalSyncRuns.id, id));
  }

  /** A worker that died mid-run leaves `running` behind; fail it so the next run can start. */
  private async reapStaleRuns(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - STALE_RUN_MS);
    const stale = await this.database.db
      .update(gojekPortalSyncRuns)
      .set({
        status: 'failed',
        message:
          'Proses tidak selesai dalam batas waktu (kemungkinan server dimulai ulang). Coba jalankan lagi.',
        finishedAt: now,
      })
      .where(
        and(eq(gojekPortalSyncRuns.status, 'running'), lt(gojekPortalSyncRuns.startedAt, cutoff)),
      )
      .returning({ id: gojekPortalSyncRuns.id });
    for (const r of stale) this.logger.warn(`sync run ${r.id} marked failed (stale)`);
  }

  private async waitForImports(ids: number[]) {
    const deadline = Date.now() + IMPORT_WAIT_MS;
    for (;;) {
      const states = await this.importService.getGojekBatchStates(ids);
      const pending = states.some((s) => s.status === 'pending' || s.status === 'processing');
      if (!pending && states.length === ids.length) return states;
      if (Date.now() >= deadline) {
        throw new GojekPortalError(
          'report_timeout',
          'Import berkas belum selesai setelah 15 menit — periksa Riwayat Import.',
        );
      }
      await new Promise((r) => setTimeout(r, IMPORT_POLL_MS));
    }
  }

  private storedDigest(settings: SettingsRow | null): string {
    if (!settings?.passwordDigestEnc) return '';
    return this.cipher.decrypt(settings.passwordDigestEnc);
  }

  private requireCipher(): void {
    if (!this.cipher.isConfigured()) {
      throw new HttpException(
        'GOJEK_PORTAL_ENCRYPTION_KEY belum diatur di server — kata sandi portal belum bisa disimpan.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async userName(id: number): Promise<string | null> {
    const names = await this.userNames([id]);
    return names.get(id) ?? null;
  }

  private async userNames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const people = await this.database.db
      .select({ id: users.id, fullName: users.fullName, email: users.email })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(people.map((p) => [p.id, p.fullName ?? p.email]));
  }

  private async toRunDtos(rows: RunRow[]): Promise<GojekPortalSyncRunDto[]> {
    const names = await this.userNames(
      rows.map((r) => r.triggeredBy).filter((id): id is number => id != null),
    );
    return rows.map((r) =>
      toRunDto(r, r.triggeredBy == null ? null : (names.get(r.triggeredBy) ?? null)),
    );
  }

  private async notifyFailure(runId: number, run: RunRow, message: string): Promise<void> {
    const actorEmail =
      run.triggeredBy == null ? 'system' : ((await this.userEmail(run.triggeredBy)) ?? 'system');
    this.activityLog.record({
      audience: 'admin',
      actorId: run.triggeredBy,
      actorEmail,
      actorName: run.triggeredBy == null ? 'Sinkronisasi Portal Gojek (jadwal)' : null,
      action: SYNC_FAILURE_ACTION,
      method: 'JOB',
      path: `/admin/gojek-portal-sync/runs/${runId}`,
      resourceSummary: `${run.dateFrom} s.d. ${run.dateTo}: ${message}`.slice(0, 500),
      status: 'failure',
    });
  }

  private async userEmail(id: number): Promise<string | null> {
    const [row] = await this.database.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, id));
    return row?.email ?? null;
  }
}

function hasCredentials(s: SettingsRow | null): s is SettingsRow {
  return !!s && !!s.email && !!s.passwordDigestEnc;
}

function isRow(r: RunRow | undefined | null): r is RunRow {
  return !!r;
}

function buildFilename(range: DateRange, runId: number, ext: 'csv' | 'xlsx'): string {
  const span =
    range.dateFrom === range.dateTo ? range.dateFrom : `${range.dateFrom}_${range.dateTo}`;
  return `gojek-portal-${span}-run${runId}.${ext}`;
}

function summaryMessage(range: DateRange, importedRows: number, skippedRows: number): string {
  const periods = splitByMonth(range)
    .map(
      (s) => `${MONTHS_ID[s.month - 1]} ${s.year} (${dayLabel(s.dateFrom)}–${dayLabel(s.dateTo)})`,
    )
    .join(', ');
  let msg = `${importedRows.toLocaleString('id-ID')} baris masuk · periode: ${periods}.`;
  if (skippedRows > 0) {
    msg += ` ${skippedRows.toLocaleString('id-ID')} baris dilewati karena sudah ada di batch sebelumnya.`;
  }
  return msg;
}

function dayLabel(isoDate: string): string {
  return `${Number(isoDate.slice(8, 10))} ${MONTHS_ID[Number(isoDate.slice(5, 7)) - 1]!.slice(0, 3)}`;
}

/** Known failure classes carry an operator-ready message; anything else is wrapped. */
function operatorMessage(err: unknown): string {
  if (err instanceof GojekPortalError || err instanceof CredentialCipherError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  return `Kesalahan tak terduga: ${raw}`.slice(0, 1000);
}

function toHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof GojekPortalError) {
    // Credential problems are the caller's to fix (400); portal outages are not (502).
    return err.kind === 'login_rejected'
      ? new BadRequestException(err.message)
      : new HttpException(err.message, HttpStatus.BAD_GATEWAY);
  }
  if (err instanceof CredentialCipherError) return new BadRequestException(err.message);
  throw err;
}
