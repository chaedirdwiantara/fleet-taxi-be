/**
 * Driver management integration tests: the full lifecycle (registration →
 * document upload/checks → deposit → verification → active roster → resign →
 * deposit return), plate-allowlist gating and cross-partner isolation.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { drivers, partnerPlates, partners, roles, userRoles, users } from '../src/db/schema';

const RUN = `drv${Date.now()}`;
const PASSWORD = 'driver-test-pw';
const PLATE = `B ${String(Date.now()).slice(-4)} DRV`;

// 1x1 JPEG — tiny but valid body for the dev upload sink
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

describe('partner driver management', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let userAId: number;
  let userBId: number;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;

  async function makePartnerUser(code: string, roleId: number) {
    const { db } = database;
    const [p] = await db
      .insert(partners)
      .values({ code, name: `Partner ${code}`, type: 'shuttle' })
      .returning();
    const [u] = await db
      .insert(users)
      .values({
        email: `${code.toLowerCase()}@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        partnerId: p!.id,
      })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId });
    return { partnerId: p!.id, userId: u!.id, email: u!.email };
  }

  /** presign → PUT (dev sink) → confirm; returns the documentId. */
  async function uploadDocument(
    agent: ReturnType<typeof request.agent>,
    driverId: number,
    kind: string,
  ): Promise<number> {
    const presign = await agent
      .post(`/partner/portal/drivers/documents/${driverId}/presign`)
      .send({ kind, contentType: 'image/jpeg', sizeBytes: JPG.length })
      .expect(201);
    const { documentId, uploadUrl } = presign.body.data as {
      documentId: number;
      uploadUrl: string;
    };
    expect(uploadUrl).toBe(`/partner/portal/drivers/documents/${documentId}/upload`);
    await agent.put(uploadUrl).set('Content-Type', 'image/jpeg').send(JPG).expect(200);
    const confirm = await agent
      .post(`/partner/portal/drivers/documents/${driverId}/${documentId}/confirm`)
      .expect(201);
    expect(confirm.body.data.status).toBe('uploaded');
    return documentId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    const { db } = database;

    await db
      .insert(roles)
      .values([{ name: 'partner' }])
      .onConflictDoNothing();
    const [partnerRole] = await db.select().from(roles).where(eq(roles.name, 'partner'));

    const a = await makePartnerUser(`${RUN}-A`, partnerRole!.id);
    const b = await makePartnerUser(`${RUN}-B`, partnerRole!.id);
    partnerAId = a.partnerId;
    partnerBId = b.partnerId;
    userAId = a.userId;
    userBId = b.userId;

    agentA = request.agent(app.getHttpServer());
    agentB = request.agent(app.getHttpServer());
    await agentA
      .post('/partner/portal/login')
      .send({ email: a.email, password: PASSWORD })
      .expect(200);
    await agentB
      .post('/partner/portal/login')
      .send({ email: b.email, password: PASSWORD })
      .expect(200);

    // Partner A registers the plate; partner B does not.
    await agentA.post('/partner/portal/plates').send({ plateNumber: PLATE }).expect(201);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db.delete(drivers).where(inArray(drivers.partnerId, [partnerAId, partnerBId]));
    await db
      .delete(partnerPlates)
      .where(inArray(partnerPlates.partnerId, [partnerAId, partnerBId]));
    await db.delete(users).where(inArray(users.id, [userAId, userBId]));
    await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    await app.close();
  });

  it('rejects a registration with an unregistered plate', async () => {
    const res = await agentA
      .post('/partner/portal/driver-registrations')
      .send({ name: 'Salah Plat', plateNumber: 'Z 9999 XX' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Plat tidak terdaftar untuk partner Anda');
  });

  let driverId: number;

  it('creates a pending registration', async () => {
    const res = await agentA
      .post('/partner/portal/driver-registrations')
      .send({
        name: 'Budi Santoso',
        email: 'budi@test.example',
        phone: '0812000111',
        ktpNo: '3174000000000001',
        simNo: 'SIM-001',
        simExpired: '2027-03-15',
        plateNumber: PLATE,
        bankAccount: 'BCA 123',
      })
      .expect(201);
    const detail = res.body.data;
    driverId = detail.id;
    expect(detail.registrationStatus).toBe('pending');
    expect(detail.driverCode).toBeNull();
    expect(detail.depositStatus).toBe('none');
    expect(detail.documents).toEqual([]);
  });

  it('lists the registration and is invisible to another partner', async () => {
    const list = await agentA.get('/partner/portal/driver-registrations?q=budi').expect(200);
    expect(list.body.data.some((d: { id: number }) => d.id === driverId)).toBe(true);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);

    await agentB.get(`/partner/portal/driver-registrations/${driverId}`).expect(404);
    await agentB
      .post(`/partner/portal/drivers/documents/${driverId}/presign`)
      .send({ kind: 'ktp', contentType: 'image/jpeg', sizeBytes: JPG.length })
      .expect(404);
  });

  it('uploads identity documents, replaces on re-upload, ticks doc checks', async () => {
    const firstKtp = await uploadDocument(agentA, driverId, 'ktp');
    const secondKtp = await uploadDocument(agentA, driverId, 'ktp'); // replace semantics
    await uploadDocument(agentA, driverId, 'sim');
    await uploadDocument(agentA, driverId, 'skck');

    const detail = await agentA.get(`/partner/portal/driver-registrations/${driverId}`).expect(200);
    const docs = detail.body.data.documents as Array<{ id: number; kind: string; url?: string }>;
    const ktps = docs.filter((d) => d.kind === 'ktp');
    expect(ktps).toHaveLength(1);
    expect(ktps[0]!.id).toBe(secondKtp);
    expect(ktps[0]!.id).not.toBe(firstKtp);
    expect(ktps[0]!.url).toBeTruthy();

    for (const kind of ['ktp', 'sim', 'skck']) {
      await agentA
        .post(`/partner/portal/driver-registrations/${driverId}/doc-check`)
        .send({ kind, verified: true })
        .expect(201);
    }
  });

  it('refuses approval before the deposit is approved', async () => {
    const res = await agentA
      .post(`/partner/portal/driver-registrations/${driverId}/verify`)
      .send({ action: 'approve' })
      .expect(400);
    expect(res.body.error.message).toBe('Deposit belum disetujui');
  });

  it('requires an uploaded deposit proof before recording the deposit', async () => {
    const res = await agentA
      .post(`/partner/portal/driver-registrations/${driverId}/deposit`)
      .send({ amount: 1_500_000 })
      .expect(400);
    expect(res.body.error.message).toBe('Unggah bukti deposit terlebih dahulu');
  });

  it('runs the deposit flow: proof → waiting → approved', async () => {
    await uploadDocument(agentA, driverId, 'deposit_proof');
    const set = await agentA
      .post(`/partner/portal/driver-registrations/${driverId}/deposit`)
      .send({ amount: 1_500_000 })
      .expect(201);
    expect(set.body.data.depositStatus).toBe('waiting');
    expect(set.body.data.depositAmount).toBe(1_500_000);

    const decided = await agentA
      .post(`/partner/portal/driver-registrations/${driverId}/deposit/decision`)
      .send({ action: 'approve' })
      .expect(201);
    expect(decided.body.data.depositStatus).toBe('approved');
    expect(decided.body.data.depositDecidedAt).toBeTruthy();

    // Deciding again conflicts (no longer waiting)
    await agentA
      .post(`/partner/portal/driver-registrations/${driverId}/deposit/decision`)
      .send({ action: 'approve' })
      .expect(409);
  });

  it('approves the registration, assigns a driver code, moves to the drivers list', async () => {
    const res = await agentA
      .post(`/partner/portal/driver-registrations/${driverId}/verify`)
      .send({ action: 'approve' })
      .expect(201);
    expect(res.body.data.registrationStatus).toBe('approved');
    expect(res.body.data.driverCode).toBe(`DRV-${String(driverId).padStart(6, '0')}`);

    // Gone from the registration slice…
    await agentA.get(`/partner/portal/driver-registrations/${driverId}`).expect(404);
    const regList = await agentA.get('/partner/portal/driver-registrations').expect(200);
    expect(regList.body.data.some((d: { id: number }) => d.id === driverId)).toBe(false);

    // …present in the active roster, invisible to partner B
    const list = await agentA.get('/partner/portal/drivers?active=true').expect(200);
    expect(list.body.data.some((d: { id: number }) => d.id === driverId)).toBe(true);
    await agentB.get(`/partner/portal/drivers/${driverId}`).expect(404);
  });

  it('re-validates the plate allowlist on driver PATCH', async () => {
    await agentA
      .patch(`/partner/portal/drivers/${driverId}`)
      .send({ plateNumber: 'Z 8888 NO' })
      .expect(400);
    const ok = await agentA
      .patch(`/partner/portal/drivers/${driverId}`)
      .send({ phone: '0812999888', isActive: true })
      .expect(200);
    expect(ok.body.data.phone).toBe('0812999888');
  });

  it('resigns the driver and surfaces them in the resignation list', async () => {
    const res = await agentA.post(`/partner/portal/drivers/${driverId}/resign`).expect(201);
    expect(res.body.data.resignedAt).toBeTruthy();
    expect(res.body.data.depositReturnStatus).toBe('none');

    await agentA.post(`/partner/portal/drivers/${driverId}/resign`).expect(409); // already resigned
    await agentA.get(`/partner/portal/drivers/${driverId}`).expect(404);

    const list = await agentA.get('/partner/portal/driver-resignations').expect(200);
    const row = list.body.data.find((d: { id: number }) => d.id === driverId);
    expect(row).toBeTruthy();
    expect(row.depositAmount).toBe(1_500_000);
    expect(row.joinedAt).toBeTruthy();
    await agentB.get(`/partner/portal/driver-resignations/${driverId}`).expect(404);
  });

  it('runs the deposit-return flow: proof required → waiting → approved', async () => {
    const missing = await agentA
      .post(`/partner/portal/driver-resignations/${driverId}/deposit-return`)
      .expect(400);
    expect(missing.body.error.message).toBe('Unggah bukti pengembalian terlebih dahulu');

    await uploadDocument(agentA, driverId, 'deposit_return_proof');
    const waiting = await agentA
      .post(`/partner/portal/driver-resignations/${driverId}/deposit-return`)
      .expect(201);
    expect(waiting.body.data.depositReturnStatus).toBe('waiting');

    const decided = await agentA
      .post(`/partner/portal/driver-resignations/${driverId}/deposit-return/decision`)
      .send({ action: 'approve' })
      .expect(201);
    expect(decided.body.data.depositReturnStatus).toBe('approved');
    expect(decided.body.data.depositReturnDecidedAt).toBeTruthy();

    await agentA
      .post(`/partner/portal/driver-resignations/${driverId}/deposit-return/decision`)
      .send({ action: 'reject' })
      .expect(409);
  });

  it('rejects a registration with a note, then allows deleting it', async () => {
    const create = await agentA
      .post('/partner/portal/driver-registrations')
      .send({ name: 'Calon Ditolak' })
      .expect(201);
    const id = create.body.data.id as number;

    const rejected = await agentA
      .post(`/partner/portal/driver-registrations/${id}/verify`)
      .send({ action: 'reject', rejectNote: 'Dokumen tidak jelas' })
      .expect(201);
    expect(rejected.body.data.registrationStatus).toBe('rejected');
    expect(rejected.body.data.rejectNote).toBe('Dokumen tidak jelas');

    await agentB.delete(`/partner/portal/driver-registrations/${id}`).expect(404);
    await agentA.delete(`/partner/portal/driver-registrations/${id}`).expect(200);
    await agentA.get(`/partner/portal/driver-registrations/${id}`).expect(404);
  });

  describe('evidence-state invalidation and delete guards', () => {
    let regId: number;

    const detail = async () =>
      (await agentA.get(`/partner/portal/driver-registrations/${regId}`).expect(200)).body
        .data as Record<string, unknown> & { documents: Array<{ id: number; kind: string }> };

    beforeAll(async () => {
      const res = await agentA
        .post('/partner/portal/driver-registrations')
        .send({ name: 'Cek Bukti', email: 'cek@test.example', simExpired: '2028-01-01' })
        .expect(201);
      regId = res.body.data.id as number;
    });

    it('blocks a doc-check until a document of that kind is uploaded', async () => {
      const res = await agentA
        .post(`/partner/portal/driver-registrations/${regId}/doc-check`)
        .send({ kind: 'ktp', verified: true })
        .expect(400);
      expect(res.body.error.message).toBe('Unggah dokumen terlebih dahulu');
    });

    it('resets ktpVerified when the ktp document is deleted', async () => {
      const docId = await uploadDocument(agentA, regId, 'ktp');
      await agentA
        .post(`/partner/portal/driver-registrations/${regId}/doc-check`)
        .send({ kind: 'ktp', verified: true })
        .expect(201);
      expect((await detail()).ktpVerified).toBe(true);

      await agentA.delete(`/partner/portal/drivers/documents/${regId}/${docId}`).expect(200);
      const after = await detail();
      expect(after.ktpVerified).toBe(false);
      expect(after.documents.some((d) => d.kind === 'ktp')).toBe(false);
    });

    it('resets the deposit to none when the proof is replaced before approval', async () => {
      await uploadDocument(agentA, regId, 'deposit_proof');
      const set = await agentA
        .post(`/partner/portal/driver-registrations/${regId}/deposit`)
        .send({ amount: 2_000_000 })
        .expect(201);
      expect(set.body.data.depositStatus).toBe('waiting');

      await uploadDocument(agentA, regId, 'deposit_proof'); // replace pre-approval
      const after = await detail();
      expect(after.depositStatus).toBe('none');
      expect(after.depositNote).toBeNull();
      expect(after.depositDecidedAt).toBeNull();
      expect(after.depositAmount).toBe(2_000_000); // amount is kept
    });

    it('blocks deleting a registration once its deposit is approved', async () => {
      await agentA
        .post(`/partner/portal/driver-registrations/${regId}/deposit`)
        .send({ amount: 2_000_000 })
        .expect(201);
      await agentA
        .post(`/partner/portal/driver-registrations/${regId}/deposit/decision`)
        .send({ action: 'approve' })
        .expect(201);

      const res = await agentA.delete(`/partner/portal/driver-registrations/${regId}`).expect(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toBe(
        'Deposit sudah disetujui — proses pengembalian deposit terlebih dahulu.',
      );
    });

    it('clears email and simExpired via PATCH with empty strings', async () => {
      const res = await agentA
        .patch(`/partner/portal/driver-registrations/${regId}`)
        .send({ email: '', simExpired: '' })
        .expect(200);
      expect(res.body.data.email).toBeNull();
      expect(res.body.data.simExpired).toBeNull();
    });
  });
});
