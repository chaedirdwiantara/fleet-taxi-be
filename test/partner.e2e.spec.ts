/**
 * M4 deliverable tests: a partner sees ONLY its own data on both surfaces
 * (portal + external /partner/v1), API-key scopes gate routes, pricelist
 * ports the legacy pool/combination rules, exports stream real files.
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
import { orders, partners, roles, userRoles, users } from '../src/db/schema';
import { ApiKeysService } from '../src/partners/api-keys.service';

const RUN = `ptn${Date.now()}`;
const PASSWORD = 'partner-test-pw';

describe('partner portal + external API (M4 deliverable)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let userAId: number;
  let keyA: string; // full scopes
  let keyAReadOnly: string; // no order:create
  let orderAId: number;
  let orderBId: number;

  const portalAgent = () => request.agent(app.getHttpServer());

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

    const [pa] = await db
      .insert(partners)
      .values({ code: `${RUN}-A`, name: 'Partner A', type: 'shuttle' })
      .returning();
    const [pb] = await db
      .insert(partners)
      .values({ code: `${RUN}-B`, name: 'Partner B', type: 'shuttle' })
      .returning();
    partnerAId = pa!.id;
    partnerBId = pb!.id;

    const [ua] = await db
      .insert(users)
      .values({
        email: `${RUN}-a@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        partnerId: partnerAId,
      })
      .returning();
    userAId = ua!.id;
    await db.insert(userRoles).values({ userId: userAId, roleId: partnerRole!.id });

    const [oa] = await db
      .insert(orders)
      .values({
        orderNumber: `${RUN}-ORD-A`,
        partnerId: partnerAId,
        tripStatus: 'submitted',
        basicPrice: 65000,
      })
      .returning();
    const [ob] = await db
      .insert(orders)
      .values({
        orderNumber: `${RUN}-ORD-B`,
        partnerId: partnerBId,
        tripStatus: 'submitted',
        basicPrice: 65000,
      })
      .returning();
    orderAId = oa!.id;
    orderBId = ob!.id;

    const apiKeysService = app.get(ApiKeysService);
    keyA = (
      await apiKeysService.createKey({
        partnerId: partnerAId,
        label: 'full',
        scopes: ['pricelist', 'order:create', 'order:read'],
      })
    ).rawKey;
    keyAReadOnly = (
      await apiKeysService.createKey({
        partnerId: partnerAId,
        label: 'read-only',
        scopes: ['order:read'],
      })
    ).rawKey;
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db.delete(orders).where(inArray(orders.partnerId, [partnerAId, partnerBId]));
    await db.delete(users).where(eq(users.id, userAId));
    await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    await app.close();
  });

  // ── portal ─────────────────────────────────────────────────────────────
  it('portal login requires a partner account; admin creds are rejected', async () => {
    const res = await portalAgent()
      .post('/partner/portal/login')
      .send({ email: 'admin@fleet-taxi.id', password: 'admin-dev-password' });
    // seeded admin exists but has no partner role → same 401 as bad credentials
    expect(res.status).toBe(401);
  });

  it('portal: me + dashboard + own-orders list, all row-scoped', async () => {
    const agent = portalAgent();
    await agent
      .post('/partner/portal/login')
      .send({ email: `${RUN}-a@test.example`, password: PASSWORD })
      .expect(200);

    const me = await agent.get('/partner/portal/me').expect(200);
    expect(me.body.data.partner.code).toBe(`${RUN}-A`);

    const dash = await agent.get('/partner/portal/dashboard').expect(200);
    expect(dash.body.data.totalOrders).toBe(1);
    expect(dash.body.data.recentOrders[0].orderNumber).toBe(`${RUN}-ORD-A`);

    const list = await agent.get('/partner/portal/orders').expect(200);
    expect(list.body.meta.total).toBe(1);
    expect(list.body.data[0].orderNumber).toBe(`${RUN}-ORD-A`);

    await agent.get(`/partner/portal/orders/${orderAId}`).expect(200);
    const cross = await agent.get(`/partner/portal/orders/${orderBId}`).expect(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  it('portal: exports own orders as xlsx and pdf', async () => {
    const agent = portalAgent();
    await agent
      .post('/partner/portal/login')
      .send({ email: `${RUN}-a@test.example`, password: PASSWORD })
      .expect(200);

    const asBuffer = (req: request.Test) =>
      req.buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    const xlsx = await asBuffer(agent.get('/partner/portal/orders/export?format=xlsx')).expect(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).length).toBeGreaterThan(1000);

    const pdf = await asBuffer(agent.get('/partner/portal/orders/export?format=pdf')).expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  }, 30_000);

  // ── external /partner/v1 ───────────────────────────────────────────────
  it('pricelist ports the legacy pool whitelist and combination pricing', async () => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${keyA}` };

    const ok = await http
      .get('/partner/v1/pricelist?pickupCode=BHISA_CAWANG&destinationCode=EVISTA_HALIM')
      .set(auth)
      .expect(200);
    expect(ok.body.data).toEqual({
      priceListId: '1',
      pickupCode: 'BHISA_CAWANG',
      destinationCode: 'EVISTA_HALIM',
      price: 65000,
    });

    const reverse = await http
      .get('/partner/v1/pricelist?pickupCode=EVISTA_HALIM&destinationCode=BHISA_CAWANG')
      .set(auth)
      .expect(200);
    expect(reverse.body.data.priceListId).toBe('2');

    const badPool = await http
      .get('/partner/v1/pricelist?pickupCode=NOWHERE&destinationCode=EVISTA_HALIM')
      .set(auth)
      .expect(422);
    expect(badPool.body.error.code).toBe('VALIDATION_ERROR');

    const badCombo = await http
      .get('/partner/v1/pricelist?pickupCode=EVISTA_HALIM&destinationCode=EVISTA_HALIM')
      .set(auth)
      .expect(422);
    expect(badCombo.body.success).toBe(false);
  });

  it('creates an order via POST JSON (swap-trip rule) and lists only own orders', async () => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${keyA}` };

    const created = await http
      .post('/partner/v1/orders')
      .set(auth)
      .send({
        pickupCode: 'BHISA_CAWANG',
        destinationCode: 'EVISTA_HALIM',
        carTypesId: 1,
        pickupAt: '2026-07-10 09:00:00',
        passengerDetails: { name: 'Tester', pax: 2 },
      })
      .expect(201);
    const order = created.body.data;
    expect(order.partnerId).toBe(partnerAId);
    expect(order.basicPrice).toBe(65000);
    expect(order.isSwapTrip).toBe(true); // destination EVISTA_HALIM
    expect(order.orderType).toBe('later');
    // "2026-07-10 09:00:00" Jakarta == 02:00 UTC
    expect(new Date(order.pickupAt).toISOString()).toBe('2026-07-10T02:00:00.000Z');

    const list = await http.get('/partner/v1/orders').set(auth).expect(200);
    const numbers = list.body.data.map((o: { orderNumber: string }) => o.orderNumber);
    expect(numbers).toContain(`${RUN}-ORD-A`);
    expect(numbers).not.toContain(`${RUN}-ORD-B`);

    const cross = await http.get(`/partner/v1/orders/${orderBId}`).set(auth).expect(403);
    expect(cross.body.error.code).toBe('FORBIDDEN');
  });

  it('enforces API-key scopes: read-only key cannot create orders or read pricelist', async () => {
    const http = request(app.getHttpServer());
    const auth = { Authorization: `Bearer ${keyAReadOnly}` };

    await http.get('/partner/v1/orders').set(auth).expect(200);

    const create = await http
      .post('/partner/v1/orders')
      .set(auth)
      .send({
        pickupCode: 'BHISA_CAWANG',
        destinationCode: 'EVISTA_HALIM',
        carTypesId: 1,
        pickupAt: '2026-07-10 09:00:00',
      })
      .expect(403);
    expect(create.body.error.code).toBe('FORBIDDEN');
    expect(create.body.error.message).toContain('order:create');

    await http
      .get('/partner/v1/pricelist?pickupCode=BHISA_CAWANG&destinationCode=EVISTA_HALIM')
      .set(auth)
      .expect(403);
  });

  it('rejects the external surface without a key and never accepts cookies there', async () => {
    const agent = portalAgent();
    await agent
      .post('/partner/portal/login')
      .send({ email: `${RUN}-a@test.example`, password: PASSWORD })
      .expect(200);
    // session cookie alone must NOT authenticate /partner/v1
    const res = await agent.get('/partner/v1/orders').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
