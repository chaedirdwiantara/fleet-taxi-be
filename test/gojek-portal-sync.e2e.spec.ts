/**
 * Gojek Fleet Partner Portal sync, end to end: super_admin-only settings,
 * encrypted credential at rest, "run now" through the queue → the real
 * GojekFleetPartnerClient (only `fetch` is faked) → the existing import
 * pipeline (one batch per month, cross-batch dedup), failure recording +
 * super_admin notification, and the scheduler's own decision.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { and, eq, inArray, like } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import {
  activityLogs,
  fleetImportDetails,
  fleetImports,
  gojekPortalSyncRuns,
  gojekPortalSyncSettings,
  roles,
  userRoles,
  users,
} from '../src/db/schema';
import { GojekFleetPartnerClient } from '../src/gojek-portal-sync/gojek-fleet-partner.client';
import {
  GojekPortalSyncService,
  SYNC_FAILURE_ACTION,
} from '../src/gojek-portal-sync/gojek-portal-sync.service';
import { makeFakePortal, PORTAL_BASE } from './helpers/gojek-portal-fetch';

const RUN = `gps${Date.now()}`;
const SUPER_EMAIL = `${RUN}-super@test.example`;
const ADMIN_EMAIL = `${RUN}-admin@test.example`;
const PASSWORD = 'test-password-123';

const PORTAL_EMAIL = 'finance@rental-test.id';
const PORTAL_PASSWORD = 'PortalRahasia!42';
const PORTAL_DIGEST = GojekFleetPartnerClient.passwordDigest(PORTAL_PASSWORD);

// Far-past period + plates no other spec uses: the all-time Outstanding of a
// plate sums EVERY period, so shared plates would leak into sibling specs.
const REPORT_CSV = [
  'Some banner line,,,,,,,,',
  'Date & Time(JKT),Driver ID,Driver Name,Phone,Vehicle,Amount,Total Outstanding Balance,Type,GoPay Transaction Reference ID',
  '28/02/2021 09:00:00,D1,Budi,0812,B 9101 GPS,488000,0,due,REF-FEB',
  '04/03/2021 09:00:00,D1,Budi,0812,B 9101 GPS,488000,0,Deduction,REF-1',
  '05/03/2021 09:00:00,D1,Budi,0812,B 9101 GPS,250000,0,Deduction,REF-2',
  // an identical row inside ONE sheet is a genuine second transaction
  '05/03/2021 09:00:00,D1,Budi,0812,B 9101 GPS,250000,0,Deduction,REF-2',
  '20/03/2021 10:00:00,D2,Siti,0813,B 9102 GPS,600000,0,due,REF-3', // outside the range
].join('\n');

interface RunBody {
  id: number;
  status: string;
  trigger: string;
  dateFrom: string;
  dateTo: string;
  reportId: number | null;
  filename: string | null;
  importedRows: number | null;
  skippedRows: number | null;
  importIds: number[];
  message: string | null;
}

async function until<T>(fn: () => Promise<T | null>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('gojek portal sync (super_admin only)', () => {
  let app: INestApplication;
  const untilFinished = (runId: number) =>
    until(async () => {
      const r = await superAgent.get(`/admin/gojek-portal-sync/runs/${runId}`).expect(200);
      const body = r.body as { data: RunBody };
      return body.data.status === 'running' ? null : body.data;
    });
  let database: DatabaseService;
  let service: GojekPortalSyncService;
  let superAgent: ReturnType<typeof request.agent>;
  let adminAgent: ReturnType<typeof request.agent>;
  const portal = makeFakePortal({
    email: PORTAL_EMAIL,
    passwordDigest: PORTAL_DIGEST,
    file: Buffer.from(REPORT_CSV),
    pendingPolls: 2,
  });
  const runIds: number[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GojekFleetPartnerClient)
      .useValue(
        new GojekFleetPartnerClient(
          { pollIntervalMs: 5 },
          {
            fetch: portal.fetch,
            sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
          },
        ),
      )
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    database = app.get(DatabaseService);
    service = app.get(GojekPortalSyncService);
    const { db } = database;
    // a leftover settings row from an aborted run would skew "fresh" assertions
    await db.delete(gojekPortalSyncSettings);

    await db
      .insert(roles)
      .values([{ name: 'super_admin' }, { name: 'admin' }])
      .onConflictDoNothing();
    const roleRows = await db
      .select()
      .from(roles)
      .where(inArray(roles.name, ['super_admin', 'admin']));
    const roleId = (name: string) => roleRows.find((r) => r.name === name)!.id;

    for (const [email, role] of [
      [SUPER_EMAIL, 'super_admin'],
      [ADMIN_EMAIL, 'admin'],
    ] as const) {
      const [u] = await db
        .insert(users)
        .values({ email, passwordHash: await argon2.hash(PASSWORD), fullName: `E2E ${role}` })
        .returning();
      await db.insert(userRoles).values({ userId: u!.id, roleId: roleId(role) });
    }

    superAgent = request.agent(app.getHttpServer());
    await superAgent
      .post('/admin/auth/login')
      .send({ email: SUPER_EMAIL, password: PASSWORD })
      .expect(200);
    adminAgent = request.agent(app.getHttpServer());
    await adminAgent
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    const { db } = database;
    if (runIds.length) {
      await db.delete(fleetImports).where(inArray(fleetImports.syncRunId, runIds)); // details cascade
      await db.delete(gojekPortalSyncRuns).where(inArray(gojekPortalSyncRuns.id, runIds));
    }
    await db.delete(gojekPortalSyncSettings);
    await db.delete(activityLogs).where(eq(activityLogs.action, SYNC_FAILURE_ACTION));
    await db.delete(users).where(like(users.email, `${RUN}%`));
    await app.close();
  });

  // ---- authorization -----------------------------------------------------

  it('401 UNAUTHENTICATED without a session', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/gojek-portal-sync/settings')
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('403 FORBIDDEN for a plain admin on every endpoint', async () => {
    const forbidden = (r: request.Response) => expect(r.body.error.code).toBe('FORBIDDEN');
    await adminAgent.get('/admin/gojek-portal-sync/settings').expect(403).expect(forbidden);
    await adminAgent.get('/admin/gojek-portal-sync/status').expect(403).expect(forbidden);
    await adminAgent.get('/admin/gojek-portal-sync/runs').expect(403).expect(forbidden);
    await adminAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({ email: PORTAL_EMAIL, isEnabled: false, runAt: '05:00', lookbackDays: 1 })
      .expect(403)
      .expect(forbidden);
    await adminAgent.post('/admin/gojek-portal-sync/test-connection').send({}).expect(403);
    await adminAgent.post('/admin/gojek-portal-sync/runs').send({}).expect(403).expect(forbidden);
  });

  // ---- settings ----------------------------------------------------------

  it('starts unconfigured: no account, no password, encryption key present', async () => {
    const res = await superAgent.get('/admin/gojek-portal-sync/settings').expect(200);
    expect(res.body.data).toMatchObject({
      email: null,
      hasPassword: false,
      isEnabled: false,
      runAt: '05:00',
      lookbackDays: 1,
      encryptionConfigured: true,
    });
    const status = await superAgent.get('/admin/gojek-portal-sync/status').expect(200);
    expect(status.body.data).toMatchObject({ hasCredentials: false, nextScheduledAt: null });
  });

  it('refuses to enable the schedule before a password is on file', async () => {
    const res = await superAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({ email: PORTAL_EMAIL, isEnabled: true, runAt: '05:00', lookbackDays: 1 })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/Kata sandi portal belum diisi/);
  });

  it('validates runAt (30-minute grid) and lookbackDays (1..7)', async () => {
    await superAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({ email: PORTAL_EMAIL, isEnabled: false, runAt: '05:15', lookbackDays: 1 })
      .expect(400);
    await superAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({ email: PORTAL_EMAIL, isEnabled: false, runAt: '05:00', lookbackDays: 8 })
      .expect(400);
  });

  it('stores the account with an ENCRYPTED digest and never echoes the secret', async () => {
    const res = await superAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({
        email: PORTAL_EMAIL,
        password: PORTAL_PASSWORD,
        isEnabled: false,
        runAt: '05:30',
        lookbackDays: 2,
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      email: PORTAL_EMAIL,
      hasPassword: true,
      isEnabled: false,
      runAt: '05:30',
      lookbackDays: 2,
      lastVerifiedAt: null,
      updatedByName: 'E2E super_admin',
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(PORTAL_PASSWORD);
    expect(body).not.toContain(PORTAL_DIGEST);
    expect(res.body.data).not.toHaveProperty('password');
    expect(res.body.data).not.toHaveProperty('passwordDigestEnc');

    const [row] = await database.db.select().from(gojekPortalSyncSettings);
    expect(row!.passwordDigestEnc).toMatch(/^v1:/);
    expect(row!.passwordDigestEnc).not.toContain(PORTAL_DIGEST);
    expect(row!.passwordDigestEnc).not.toContain(PORTAL_PASSWORD);
  });

  it('keeps the stored password when the field is left empty', async () => {
    const res = await superAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({ email: PORTAL_EMAIL, isEnabled: false, runAt: '05:30', lookbackDays: 2 })
      .expect(200);
    expect(res.body.data.hasPassword).toBe(true);
  });

  // ---- test connection ---------------------------------------------------

  it('test-connection logs in with the stored digest and remembers lastVerifiedAt', async () => {
    const before = portal.calls.length;
    const res = await superAgent
      .post('/admin/gojek-portal-sync/test-connection')
      .send({})
      .expect(200);
    expect(res.body.data.email).toBe(PORTAL_EMAIL);
    expect(res.body.data.verifiedAt).toEqual(expect.any(String));

    const login = portal.calls[before]!;
    expect(login.url).toBe(`${PORTAL_BASE}auth/login`); // absolute, live host
    expect(login.body).toEqual({ email: PORTAL_EMAIL, password: PORTAL_DIGEST });

    const settings = await superAgent.get('/admin/gojek-portal-sync/settings').expect(200);
    expect(settings.body.data.lastVerifiedAt).toEqual(expect.any(String));
  });

  it('test-connection with a wrong typed password is a 400 with the portal reason', async () => {
    const res = await superAgent
      .post('/admin/gojek-portal-sync/test-connection')
      .send({ password: 'salah' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/Login portal Gojek ditolak/);
  });

  // ---- run now -----------------------------------------------------------

  it('validates a manual range (order, max 31 days, not in the future)', async () => {
    await superAgent
      .post('/admin/gojek-portal-sync/runs')
      .send({ dateFrom: '2021-03-05', dateTo: '2021-03-01' })
      .expect(400)
      .expect((r) => expect(r.body.error.message).toMatch(/awal tidak boleh melewati/));
    await superAgent
      .post('/admin/gojek-portal-sync/runs')
      .send({ dateFrom: '2021-01-01', dateTo: '2021-03-05' })
      .expect(400)
      .expect((r) => expect(r.body.error.message).toMatch(/maksimal 31 hari/));
    await superAgent
      .post('/admin/gojek-portal-sync/runs')
      .send({ dateFrom: '2099-01-01', dateTo: '2099-01-02' })
      .expect(400)
      .expect((r) => expect(r.body.error.message).toMatch(/melewati hari ini/));
  });

  it('runs a straddling range as one import batch per month through the queue', async () => {
    const res = await superAgent
      .post('/admin/gojek-portal-sync/runs')
      .send({ dateFrom: '2021-02-28', dateTo: '2021-03-05' })
      .expect(202);
    expect(res.body.data).toMatchObject({
      status: 'running',
      trigger: 'manual',
      dateFrom: '2021-02-28',
      dateTo: '2021-03-05',
      triggeredByName: 'E2E super_admin',
    });
    const runId: number = res.body.data.id;
    runIds.push(runId);

    const run = await untilFinished(runId);
    expect(run).toMatchObject({
      status: 'success',
      reportId: 77,
      filename: `gojek-portal-2021-02-28_2021-03-05-run${runId}.csv`,
      importedRows: 4, // Feb 28 + Mar 4 + Mar 5 ×2; Mar 20 is outside the range
      skippedRows: 0,
    });
    expect(run.importIds).toHaveLength(2);
    expect(run.message).toMatch(
      /4 baris masuk · periode: Februari 2021 \(28 Feb–28 Feb\), Maret 2021 \(1 Mar–5 Mar\)/,
    );

    // the portal was asked for exactly the WIB→UTC window of the range
    const exportCall = portal.calls.find((c) => c.url === `${PORTAL_BASE}report/export`)!;
    expect(exportCall.body).toEqual({
      type: 1,
      date_from: '2021-02-27T17:00:00.000Z',
      date_to: '2021-03-05T16:59:59.999Z',
    });

    // batches are marked as portal-born and split per period
    const batches = await database.db
      .select()
      .from(fleetImports)
      .where(eq(fleetImports.syncRunId, runId));
    expect(
      batches.map((b) => [b.periodYear, b.periodMonth, b.status, b.source, b.totalRows]).sort(),
    ).toEqual([
      [2021, 2, 'done', 'portal', 1],
      [2021, 3, 'done', 'portal', 3],
    ]);
    const marchRows = await database.db
      .select()
      .from(fleetImportDetails)
      .where(
        and(
          eq(fleetImportDetails.periodYear, 2021),
          eq(fleetImportDetails.periodMonth, 3),
          inArray(
            fleetImportDetails.importId,
            batches.map((b) => b.id),
          ),
        ),
      );
    expect(marchRows.map((r) => r.transactionDate).sort()).toEqual([
      '2021-03-04',
      '2021-03-05',
      '2021-03-05',
    ]);

    // the list endpoint + status summary see it
    const list = await superAgent
      .get('/admin/gojek-portal-sync/runs?page=1&pageSize=5')
      .expect(200);
    expect(list.body.meta).toMatchObject({ page: 1, pageSize: 5 });
    expect(list.body.data[0].id).toBe(runId);
    const status = await superAgent.get('/admin/gojek-portal-sync/status').expect(200);
    expect(status.body.data.lastSuccess.id).toBe(runId);
    expect(status.body.data.runningRun).toBeNull();
  }, 60_000);

  it('re-pulling the same days skips rows the period already holds (no double counting)', async () => {
    const res = await superAgent
      .post('/admin/gojek-portal-sync/runs')
      .send({ dateFrom: '2021-02-28', dateTo: '2021-03-05' })
      .expect(202);
    const runId: number = res.body.data.id;
    runIds.push(runId);
    const run = await untilFinished(runId);
    expect(run).toMatchObject({ status: 'success', importedRows: 0, skippedRows: 4 });
    expect(run.message).toMatch(/4 baris dilewati/);
  }, 60_000);

  it('records a portal failure with an operator message and notifies super_admins', async () => {
    portal.options.reportFailure = 'Report generation failed';
    const res = await superAgent
      .post('/admin/gojek-portal-sync/runs')
      .send({ dateFrom: '2021-03-01', dateTo: '2021-03-01' })
      .expect(202);
    const runId: number = res.body.data.id;
    runIds.push(runId);
    const run = await untilFinished(runId);
    portal.options.reportFailure = undefined;
    expect(run.status).toBe('failed');
    expect(run.message).toMatch(
      /Portal Gojek gagal menyusun laporan #77: Report generation failed/,
    );
    expect(run.importIds).toEqual([]);

    const log = await until(async () => {
      const rows = await database.db
        .select()
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.action, SYNC_FAILURE_ACTION),
            eq(activityLogs.path, `/admin/gojek-portal-sync/runs/${runId}`),
          ),
        );
      return rows[0] ?? null;
    }, 10_000);
    expect(log).toMatchObject({ audience: 'admin', status: 'failure', actorEmail: SUPER_EMAIL });
    expect(log.resourceSummary).toMatch(/Report generation failed/);
  }, 60_000);

  // ---- scheduler ---------------------------------------------------------

  it('the tick skips while the schedule is off, runs once past run-at, then waits for tomorrow', async () => {
    expect(await service.runScheduledTick()).toMatchObject({
      due: false,
      reason: 'Sinkronisasi terjadwal nonaktif.',
    });

    await superAgent
      .put('/admin/gojek-portal-sync/settings')
      .send({ email: PORTAL_EMAIL, isEnabled: true, runAt: '00:00', lookbackDays: 1 })
      .expect(200);

    const first = await service.runScheduledTick();
    expect(first.due).toBe(true);
    expect(first.runId).toEqual(expect.any(Number));
    runIds.push(first.runId!);
    const run = await superAgent.get(`/admin/gojek-portal-sync/runs/${first.runId}`).expect(200);
    // yesterday's window holds none of the fixture's 2021 rows → a clean empty success
    expect(run.body.data).toMatchObject({
      trigger: 'schedule',
      status: 'success',
      importedRows: 0,
    });
    expect(run.body.data.dateFrom).toBe(run.body.data.dateTo);

    expect(await service.runScheduledTick()).toMatchObject({
      due: false,
      reason: 'Sudah berhasil hari ini.',
    });
    const status = await superAgent.get('/admin/gojek-portal-sync/status').expect(200);
    expect(status.body.data).toMatchObject({ isEnabled: true, todayScheduledAttempts: 1 });
    expect(status.body.data.nextScheduledAt).toEqual(expect.any(String));
  }, 60_000);
});

describe('gojek portal client through the real DI graph', () => {
  it('resolves with the live portal base URL (no empty/relative client from the container)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const client = app.get(GojekFleetPartnerClient);
      expect(client).toBeInstanceOf(GojekFleetPartnerClient);
      expect(client.resolveUrl('auth/login')).toBe(
        'https://fleetpartner.gojek.com/api/api/v1/auth/login',
      );
    } finally {
      await app.close();
    }
  }, 30_000);
});
