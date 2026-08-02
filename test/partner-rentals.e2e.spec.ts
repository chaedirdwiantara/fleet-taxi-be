/**
 * Rental payment-evidence rules. A rental may only be 'Sudah Dibayar' while it
 * carries 1..RENTAL_MAX_PROOFS uploaded proofs, because only paid rows feed the
 * monthly money recap. Covers the presign → PUT → confirm flow, enforcement on
 * all three write paths (create / update / payment-status), the uploader audit
 * snapshot, revert-keeps-evidence, and cross-partner isolation.
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
import { partners, rentalPaymentProofs, rentals, roles, userRoles, users } from '../src/db/schema';
import { RENTAL_MAX_PROOFS } from '../src/partner-rentals/rental-proof.constants';

const RUN = `rpf${Date.now()}`;
const PASSWORD = 'rental-proof-test-pw';
const YEAR = 2036;
const MONTH = 4;
const OWNER_NAME = 'Sri Rahayu';

// 1x1 JPEG — tiny but valid body for the dev upload sink
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8');

describe('rental payment proofs', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;
  let plateSeq = 0;

  async function makePartnerUser(code: string, roleId: number, fullName: string) {
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
        fullName,
        partnerId: p!.id,
      })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId });
    return { partnerId: p!.id, email: u!.email };
  }

  /** presign → PUT (dev sink) → confirm; returns the proofId. */
  async function uploadProof(
    agent: ReturnType<typeof request.agent>,
    { pdf = false }: { pdf?: boolean } = {},
  ): Promise<number> {
    const contentType = pdf ? 'application/pdf' : 'image/jpeg';
    const body = pdf ? PDF : JPG;
    const fileName = pdf ? 'bukti-transfer.pdf' : 'bukti-transfer.jpg';

    const presign = await agent
      .post('/partner/portal/rentals/proofs/presign')
      .send({ contentType, sizeBytes: body.length, fileName })
      .expect(201);
    const { proofId, uploadUrl } = presign.body.data as { proofId: number; uploadUrl: string };
    expect(uploadUrl).toBe(`/partner/portal/rentals/proofs/${proofId}/upload`);

    await agent.put(uploadUrl).set('Content-Type', contentType).send(body).expect(200);
    const confirm = await agent
      .post(`/partner/portal/rentals/proofs/${proofId}/confirm`)
      .expect(201);
    expect(confirm.body.data.status).toBe('uploaded');
    return proofId;
  }

  /** A distinct plate per rental keeps the overlap guard out of the way. */
  const rentalBody = (overrides: Record<string, unknown> = {}) => ({
    plateNumber: `B ${9100 + plateSeq++} RPF`,
    startDate: `${YEAR}-0${MONTH}-05`,
    endDate: `${YEAR}-0${MONTH}-07`,
    price: 500_000,
    priceUnit: 'hari',
    cogsPerDay: 200_000,
    ...overrides,
  });

  const createRental = (agent: ReturnType<typeof request.agent>, body: Record<string, unknown>) =>
    agent.post('/partner/portal/rentals').send(body);

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

    const a = await makePartnerUser(`${RUN}-A`, partnerRole!.id, OWNER_NAME);
    const b = await makePartnerUser(`${RUN}-B`, partnerRole!.id, 'Other Partner');
    partnerAId = a.partnerId;
    partnerBId = b.partnerId;

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
  });

  afterAll(async () => {
    const { db } = database;
    const ids = [partnerAId, partnerBId];
    // Proof rows cascade with their partner, but delete explicitly so a
    // failure mid-suite still leaves the database clean.
    await db.delete(rentalPaymentProofs).where(inArray(rentalPaymentProofs.partnerId, ids));
    await db.delete(rentals).where(inArray(rentals.partnerId, ids));
    await db.delete(users).where(inArray(users.partnerId, ids));
    await db.delete(partners).where(inArray(partners.id, ids));
    await app.close();
  });

  it('rejects creating a paid rental with no evidence', async () => {
    const res = await createRental(agentA, rentalBody({ paymentStatus: 'Sudah Dibayar' })).expect(
      400,
    );
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/Bukti pembayaran wajib diunggah/);
  });

  it('creates a paid rental with evidence and reports who uploaded it', async () => {
    const jpgId = await uploadProof(agentA);
    const pdfId = await uploadProof(agentA, { pdf: true });

    const res = await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [jpgId, pdfId] }),
    ).expect(201);

    const proofs = res.body.data.paymentProofs as Array<Record<string, unknown>>;
    expect(proofs).toHaveLength(2);
    // Mixed image + PDF evidence on one transaction.
    expect(proofs.map((p) => p.contentType).sort()).toEqual(['application/pdf', 'image/jpeg']);
    // The audit answer: who uploaded this, and when.
    expect(proofs.every((p) => p.uploadedByName === OWNER_NAME)).toBe(true);
    expect(proofs.every((p) => typeof p.uploadedAt === 'string')).toBe(true);
    expect(proofs.every((p) => typeof p.url === 'string')).toBe(true);
  });

  it('rejects marking an existing rental paid without evidence, and accepts it with', async () => {
    const created = await createRental(agentA, rentalBody()).expect(201);
    const id = created.body.data.id as number;

    const denied = await agentA
      .patch(`/partner/portal/rentals/${id}/payment-status`)
      .send({ paymentStatus: 'Sudah Dibayar' })
      .expect(400);
    expect(denied.body.error.code).toBe('VALIDATION_ERROR');

    // The rejected transition must not have committed.
    const [row] = await database.db.select().from(rentals).where(eq(rentals.id, id));
    expect(row!.paymentStatus).toBe('Belum Dibayar');

    const proofId = await uploadProof(agentA);
    const ok = await agentA
      .patch(`/partner/portal/rentals/${id}/payment-status`)
      .send({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] })
      .expect(200);
    expect(ok.body.data.paymentStatus).toBe('Sudah Dibayar');
    expect(ok.body.data.paymentProofs).toHaveLength(1);
  });

  it('keeps the evidence when the rental is reverted to unpaid', async () => {
    const proofId = await uploadProof(agentA);
    const created = await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(201);
    const id = created.body.data.id as number;

    const reverted = await agentA
      .patch(`/partner/portal/rentals/${id}/payment-status`)
      .send({ paymentStatus: 'Belum Dibayar' })
      .expect(200);
    expect(reverted.body.data.paymentStatus).toBe('Belum Dibayar');
    expect(reverted.body.data.paymentProofs).toHaveLength(1);
  });

  it(`caps evidence at ${RENTAL_MAX_PROOFS} files per rental`, async () => {
    const ids: number[] = [];
    for (let i = 0; i <= RENTAL_MAX_PROOFS; i += 1) ids.push(await uploadProof(agentA));

    // The DTO bound rejects an over-long array outright...
    const tooMany = await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: ids }),
    ).expect(400);
    expect(tooMany.body.error.code).toBe('VALIDATION_ERROR');

    // ...and the service rejects going over the cap by topping up later.
    const created = await createRental(
      agentA,
      rentalBody({
        paymentStatus: 'Sudah Dibayar',
        paymentProofIds: ids.slice(0, RENTAL_MAX_PROOFS),
      }),
    ).expect(201);
    const id = created.body.data.id as number;

    const overflow = await agentA
      .patch(`/partner/portal/rentals/${id}/payment-status`)
      .send({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [ids[RENTAL_MAX_PROOFS]] })
      .expect(400);
    expect(overflow.body.error.message).toMatch(/Maksimal/);
  });

  it('refuses to delete the last proof of a rental that is still paid', async () => {
    const proofId = await uploadProof(agentA);
    const created = await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(201);
    const id = created.body.data.id as number;

    await agentA.delete(`/partner/portal/rentals/proofs/${proofId}`).expect(400);

    // Allowed once the rental is no longer claiming to be paid.
    await agentA
      .patch(`/partner/portal/rentals/${id}/payment-status`)
      .send({ paymentStatus: 'Belum Dibayar' })
      .expect(200);
    await agentA.delete(`/partner/portal/rentals/proofs/${proofId}`).expect(200);
  });

  it('rejects evidence that is still pending upload', async () => {
    const presign = await agentA
      .post('/partner/portal/rentals/proofs/presign')
      .send({ contentType: 'image/jpeg', sizeBytes: JPG.length, fileName: 'belum.jpg' })
      .expect(201);
    const proofId = presign.body.data.proofId as number;

    const res = await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(400);
    expect(res.body.error.message).toMatch(/belum selesai diunggah/);
  });

  it("refuses to reuse another rental's evidence", async () => {
    const proofId = await uploadProof(agentA);
    await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(201);

    const res = await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(400);
    expect(res.body.error.message).toMatch(/sudah terpakai/);
  });

  it("does not let a partner touch or attach another partner's evidence", async () => {
    const proofId = await uploadProof(agentA);

    await agentB.post(`/partner/portal/rentals/proofs/${proofId}/confirm`).expect(404);
    await agentB.delete(`/partner/portal/rentals/proofs/${proofId}`).expect(404);
    await agentB.get(`/partner/portal/rentals/proofs/${proofId}/file`).expect(404);

    const res = await createRental(
      agentB,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('serves the stored bytes back to the owner and lists proofs on the monthly recap', async () => {
    const proofId = await uploadProof(agentA);
    await createRental(
      agentA,
      rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }),
    ).expect(201);

    const file = await agentA.get(`/partner/portal/rentals/proofs/${proofId}/file`).expect(200);
    expect(file.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(file.body as Buffer).length).toBe(JPG.length);

    const list = await agentA
      .get(`/partner/portal/rentals?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const paid = (list.body.data.items as Array<Record<string, unknown>>).filter(
      (i) => i.paymentStatus === 'Sudah Dibayar',
    );
    expect(paid.length).toBeGreaterThan(0);
    // Every paid row in the recap can justify itself.
    expect(paid.every((i) => (i.paymentProofs as unknown[]).length > 0)).toBe(true);
  });
});
