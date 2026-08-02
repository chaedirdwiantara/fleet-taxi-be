/**
 * Per-transaction rental invoice (`GET /partner/portal/rentals/:id/invoice`).
 * Covers the paid-only precondition, the PDF payload + download headers, and
 * cross-partner isolation. Needs docker-compose Postgres + Redis and applied
 * migrations.
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

const RUN = `rinv${Date.now()}`;
const PASSWORD = 'rental-invoice-test-pw';
const YEAR = 2037;

// 1x1 JPEG — tiny but valid body for the dev upload sink
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

/** supertest buffers text by default; PDFs need an explicit binary parser. */
const asBuffer = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('rental invoice', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;
  let plateSeq = 0;

  async function makePartnerUser(code: string, roleId: number, partnerName: string) {
    const { db } = database;
    const [p] = await db
      .insert(partners)
      .values({ code, name: partnerName, type: 'shuttle' })
      .returning();
    const [u] = await db
      .insert(users)
      .values({
        email: `${code.toLowerCase()}@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        fullName: 'Petugas Partner',
        partnerId: p!.id,
      })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId });
    return { partnerId: p!.id, email: u!.email };
  }

  /** presign → PUT (dev sink) → confirm; returns the proofId. */
  async function uploadProof(agent: ReturnType<typeof request.agent>): Promise<number> {
    const presign = await agent
      .post('/partner/portal/rentals/proofs/presign')
      .send({ contentType: 'image/jpeg', sizeBytes: JPG.length, fileName: 'bukti.jpg' })
      .expect(201);
    const { proofId, uploadUrl } = presign.body.data as { proofId: number; uploadUrl: string };
    await agent.put(uploadUrl).set('Content-Type', 'image/jpeg').send(JPG).expect(200);
    await agent.post(`/partner/portal/rentals/proofs/${proofId}/confirm`).expect(201);
    return proofId;
  }

  const rentalBody = (overrides: Record<string, unknown> = {}) => ({
    plateNumber: `B ${9300 + plateSeq++} RIV`,
    vehicleType: 'Air EV',
    startDate: `${YEAR}-03-05`,
    endDate: `${YEAR}-03-07`,
    price: 500_000,
    priceUnit: 'hari',
    cogsPerDay: 200_000,
    customerName: 'Andi Wijaya',
    customerPhone: '0812-3456-7890',
    ...overrides,
  });

  /** Creates a rental already marked paid, with one uploaded proof. */
  async function createPaidRental(agent: ReturnType<typeof request.agent>): Promise<number> {
    const proofId = await uploadProof(agent);
    const res = await agent
      .post('/partner/portal/rentals')
      .send(rentalBody({ paymentStatus: 'Sudah Dibayar', paymentProofIds: [proofId] }))
      .expect(201);
    return res.body.data.id as number;
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

    const a = await makePartnerUser(`${RUN}-A`, partnerRole!.id, 'Jayana Giri Sentosa');
    const b = await makePartnerUser(`${RUN}-B`, partnerRole!.id, 'Partner Lain');
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
    await db.delete(rentalPaymentProofs).where(inArray(rentalPaymentProofs.partnerId, ids));
    await db.delete(rentals).where(inArray(rentals.partnerId, ids));
    await db.delete(users).where(inArray(users.partnerId, ids));
    await db.delete(partners).where(inArray(partners.id, ids));
    await app.close();
  });

  it('refuses to bill a rental that is not paid yet', async () => {
    const created = await agentA.post('/partner/portal/rentals').send(rentalBody()).expect(201);
    const res = await agentA
      .get(`/partner/portal/rentals/${created.body.data.id}/invoice`)
      .expect(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/sudah dibayar/i);
  });

  it('streams a PDF invoice for a paid rental, as a named download', async () => {
    const id = await createPaidRental(agentA);
    const res = await asBuffer(agentA.get(`/partner/portal/rentals/${id}/invoice`)).expect(200);

    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`attachment; filename="invoice-${YEAR}-03-\\d{5,}\\.pdf"`),
    );
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  }, 30_000);

  it("never exposes another partner's rental", async () => {
    const id = await createPaidRental(agentA);
    const res = await agentB.get(`/partner/portal/rentals/${id}/invoice`).expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  }, 30_000);

  it('adds PPN once the partner is PKP, and only to rentals written after', async () => {
    // Written while non-PKP → untaxed, and stays untaxed after settling.
    const before = await createPaidRental(agentA);

    await agentA
      .put('/partner/portal/rentals/tax-settings')
      .send({ isPkp: true, npwp: '01.234.567.8-901.000' })
      .expect(200);

    const after = await createPaidRental(agentA);
    const list = await agentA.get(`/partner/portal/rentals?month=3&year=${YEAR}`).expect(200);
    const items = list.body.data.items as Array<Record<string, number>>;
    const row = (id: number) => items.find((i) => i.id === id)!;

    expect(row(before).ppnRateBps).toBe(0);
    expect(row(before).ppnAmount).toBe(0);
    expect(row(after).ppnRateBps).toBe(1100);
    // 3 hari x 500.000 = 1.500.000 DPP -> 165.000
    expect(row(after).ppnBase).toBe(1_500_000);
    expect(row(after).ppnAmount).toBe(165_000);
    expect(row(after).totalBilled).toBe(1_665_000);

    // VAT is reported apart from revenue, never folded into it.
    const summary = list.body.data.summary as Record<string, number>;
    expect(summary.paidPpn).toBe(165_000);
    expect(summary.paidGross).toBe(summary.paidTotalBilled - summary.paidPpn);
  }, 60_000);

  it('rejects an NPWP with letters in it', async () => {
    const res = await agentA
      .put('/partner/portal/rentals/tax-settings')
      .send({ isPkp: true, npwp: 'NPWP-ABC' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404s an unknown rental id', async () => {
    const res = await agentA.get('/partner/portal/rentals/99999999/invoice').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
