/**
 * Cicilan Deposit integration tests: CRUD on installment rules, the derived
 * installment history (active days from fleet_import_details, inclusive
 * min-setoran gate, duration cap), driver-options picker, and cross-partner
 * isolation. Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { dropDetailPartition, ensureDetailPartition } from '../src/db/partitions';
import { fleetImports, partners, roles, userRoles, users } from '../src/db/schema';
import { fleetImportDetails } from '../src/db/schema/partitioned';

const RUN = `cic${Date.now()}`;
const PASSWORD = 'cicilan-test-pw';
const YEAR = 2035;
const MONTH = 3;
const PLATE_A = 'B 8801 CIA';
const PLATE_A_NORM = 'B8801CIA';
const PLATE_B = 'B 8802 CIB';
const DRIVER = 'BUDI SANTOSO';

describe('deposit installments (cicilan deposit)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let userAId: number;
  let userBId: number;
  let fleetImportId: number;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;
  let ruleId: number;

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

    await agentA.post('/partner/portal/plates').send({ plateNumber: PLATE_A }).expect(201);
    await agentB.post('/partner/portal/plates').send({ plateNumber: PLATE_B }).expect(201);

    const d = (dayNum: number) =>
      `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;

    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: 'cic.csv', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    fleetImportId = imp!.id;
    const base = {
      importId: fleetImportId,
      periodYear: YEAR,
      periodMonth: MONTH,
      vehiclePlate: PLATE_A,
      vehiclePlateNorm: PLATE_A_NORM,
      driverId: 'G-1',
      // double space on purpose — normalization must collapse it
      driverName: 'Budi  Santoso',
      type: 'GoPay Deduction',
    };
    await db.insert(fleetImportDetails).values([
      // day 1: setoran 150k (qualifies with gate 100k)
      { ...base, transactionDate: d(1), amount: -150000 },
      // day 2: two rows summing 100k — INCLUSIVE boundary must qualify
      { ...base, transactionDate: d(2), amount: -60000 },
      { ...base, transactionDate: d(2), amount: -40000 },
      // day 3: 99 999 — below the gate, must be skipped
      { ...base, transactionDate: d(3), amount: -99999 },
      // day 4: qualifies, but the 2x duration cap stops before it
      { ...base, transactionDate: d(4), amount: -200000 },
      // day 5: manual payment only (no deduction) → NOT an active day
      { ...base, transactionDate: d(5), amount: -500000, type: 'Manual Payment' },
    ]);
  });

  afterAll(async () => {
    const { db } = database;
    await db.delete(fleetImports).where(eq(fleetImports.id, fleetImportId));
    await dropDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(users).where(eq(users.id, userBId));
    await app.close();
  });

  it('driver-options lists distinct normalized drivers on own plates only', async () => {
    const res = await agentA.get('/partner/portal/deposit-installments/driver-options').expect(200);
    const options = res.body.data as Array<{ driverName: string; lastPlate: string }>;
    expect(options).toEqual([{ driverName: DRIVER, lastPlate: PLATE_A_NORM }]);

    const resB = await agentB
      .get('/partner/portal/deposit-installments/driver-options')
      .expect(200);
    expect(resB.body.data).toEqual([]);
  });

  it('creates a rule and derives the history: gate inclusive, duration capped', async () => {
    const res = await agentA
      .post('/partner/portal/deposit-installments')
      .send({
        title: 'Cicilan Deposit Budi',
        driverName: 'budi  santoso', // normalized server-side
        installmentAmount: 25000,
        installmentCount: 2,
        minDailySetoran: 100000,
        effectiveDate: `${YEAR}-0${MONTH}-01`,
        note: 'Deposit 500.000',
      })
      .expect(201);
    const row = res.body.data as Record<string, unknown>;
    ruleId = row.id as number;
    expect(row.driverName).toBe(DRIVER);
    // days 1 and 2 qualify (2 = inclusive boundary), day 3 below gate,
    // day 4 cut off by the 2x duration cap, day 5 not an active day
    expect(row.paidCount).toBe(2);
    expect(row.totalPaid).toBe(50000);
    expect(row.totalTarget).toBe(50000);
    expect(row.remaining).toBe(0);
    expect(row.status).toBe('lunas');
    expect(row.lastPlate).toBe(PLATE_A_NORM);
  });

  it('recap returns the derived per-installment history', async () => {
    const res = await agentA
      .get(`/partner/portal/deposit-installments/${ruleId}/recap`)
      .expect(200);
    const { rule, installments } = res.body.data as {
      rule: Record<string, unknown>;
      installments: Array<Record<string, unknown>>;
    };
    expect(rule.id).toBe(ruleId);
    expect(installments).toEqual([
      { seq: 1, date: `${YEAR}-03-01`, amount: 25000, dailySetoran: 150000 },
      { seq: 2, date: `${YEAR}-03-02`, amount: 25000, dailySetoran: 100000 },
    ]);
  });

  it('list supports status filter and paginated meta', async () => {
    const res = await agentA
      .get('/partner/portal/deposit-installments?status=lunas&page=1&pageSize=10')
      .expect(200);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 10, total: 1 });
    expect(res.body.data[0].id).toBe(ruleId);

    const none = await agentA
      .get('/partner/portal/deposit-installments?status=berjalan')
      .expect(200);
    expect(none.body.meta.total).toBe(0);
  });

  it('update recomputes the derivation (raising the gate drops a day)', async () => {
    const res = await agentA
      .put(`/partner/portal/deposit-installments/${ruleId}`)
      .send({
        title: 'Cicilan Deposit Budi',
        driverName: DRIVER,
        installmentAmount: 25000,
        installmentCount: 2,
        minDailySetoran: 120000, // only days 1 (150k) and 4 (200k) qualify now
        effectiveDate: `${YEAR}-0${MONTH}-01`,
      })
      .expect(200);
    const row = res.body.data as Record<string, unknown>;
    expect(row.paidCount).toBe(2);
    expect(row.status).toBe('lunas');
    const recap = await agentA
      .get(`/partner/portal/deposit-installments/${ruleId}/recap`)
      .expect(200);
    expect((recap.body.data.installments as Array<{ date: string }>).map((i) => i.date)).toEqual([
      `${YEAR}-03-01`,
      `${YEAR}-03-04`,
    ]);
  });

  it('cross-partner isolation: partner B cannot see or mutate the rule', async () => {
    const list = await agentB.get('/partner/portal/deposit-installments').expect(200);
    expect(list.body.meta.total).toBe(0);
    await agentB.get(`/partner/portal/deposit-installments/${ruleId}/recap`).expect(404);
    await agentB.delete(`/partner/portal/deposit-installments/${ruleId}`).expect(404);
  });

  it('validation: rejects zero/negative amounts and bad dates', async () => {
    await agentA
      .post('/partner/portal/deposit-installments')
      .send({
        title: 'X',
        driverName: DRIVER,
        installmentAmount: 0,
        installmentCount: 2,
        effectiveDate: '2035-03-01',
      })
      .expect(400);
    await agentA
      .post('/partner/portal/deposit-installments')
      .send({
        title: 'X',
        driverName: DRIVER,
        installmentAmount: 1000,
        installmentCount: 2,
        effectiveDate: '01-03-2035',
      })
      .expect(400);
  });

  it('delete removes the rule', async () => {
    await agentA.delete(`/partner/portal/deposit-installments/${ruleId}`).expect(200);
    const list = await agentA.get('/partner/portal/deposit-installments').expect(200);
    expect(list.body.meta.total).toBe(0);
  });
});
