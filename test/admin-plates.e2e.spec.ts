/**
 * Admin "Plate Registration" (/admin/plates): super_admin-only CRUD over the
 * admin console's own plate registry, the isolation invariant (a partner never
 * sees an admin registration), and the reason the feature exists — registering a
 * plate here makes a vehicle NO partner registered visible in the admin Gojek
 * grid. Needs docker-compose Postgres + Redis and applied migrations.
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
import {
  adminPlates,
  fleetImportDetails,
  fleetImports,
  partnerPlates,
  partners,
  roles,
  userRoles,
  users,
} from '../src/db/schema';
import { dropDetailPartition, ensureDetailPartition } from '../src/db/partitions';

const RUN = `ap${Date.now().toString(36)}`;
const PASSWORD = 'admin-plates-pw';
const SUPER_EMAIL = `${RUN}-super@test.example`;
const ADMIN_EMAIL = `${RUN}-admin@test.example`;
const PORTAL_EMAIL = `${RUN}-portal@test.example`;
const PARTNER_NAME = 'Partner Plate Registry';

// Plate norms are RUN-unique so parallel specs can never see each other's rows
// (admin_plates has no per-run scope — it is one global registry).
const PLATE_PARTNER = `${RUN}A`.toUpperCase(); // registered by the partner
const PLATE_ORPHAN = `${RUN}B`.toUpperCase(); // registered by the admin only
const PLATE_LATE = `${RUN}C`.toUpperCase(); // registered by nobody until the last test
const ADMIN_TYPE = 'Premium - Admin Entry';

// A period of its own, and deliberately NOT the newest one in the table: the
// "driver keluar" split compares each row's last transaction against the
// UNSCOPED max over fleet_import_details, so a fixture year above every other
// spec's would mark their plates exited. 2039 is the current ceiling.
const YEAR = 2038;
const MONTH = 5;

describe('admin plate registration (/admin/plates)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let superAgent: request.SuperAgentTest;
  let adminAgent: request.SuperAgentTest;
  let partnerAgent: request.SuperAgentTest;
  let partnerId: number;
  const userIds: number[] = [];

  const gridNorms = async (agent: request.SuperAgentTest, path: string): Promise<string[]> => {
    const res = await agent.get(`${path}?month=${MONTH}&year=${YEAR}`).expect(200);
    return (res.body.data.rows as { plateNorm: string }[]).map((r) => r.plateNorm);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    const { db } = database;

    await db
      .insert(roles)
      .values([{ name: 'super_admin' }, { name: 'admin' }, { name: 'partner' }])
      .onConflictDoNothing();
    const roleRows = await db
      .select()
      .from(roles)
      .where(inArray(roles.name, ['super_admin', 'admin', 'partner']));
    const roleId = (name: string) => roleRows.find((r) => r.name === name)!.id;

    const [partner] = await db
      .insert(partners)
      .values({ code: RUN.toUpperCase(), name: PARTNER_NAME, type: 'shuttle' })
      .returning();
    partnerId = partner!.id;

    for (const [email, role, ownerId] of [
      [SUPER_EMAIL, 'super_admin', null],
      [ADMIN_EMAIL, 'admin', null],
      [PORTAL_EMAIL, 'partner', partnerId],
    ] as const) {
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash: await argon2.hash(PASSWORD), partnerId: ownerId })
        .returning();
      userIds.push(user!.id);
      await db.insert(userRoles).values({ userId: user!.id, roleId: roleId(role) });
    }

    // The partner registers exactly one of the three plates in its own portal.
    await db.insert(partnerPlates).values({
      partnerId,
      plateNumber: PLATE_PARTNER,
      plateNumberNorm: PLATE_PARTNER,
      vehicleType: 'Reguler - Partner Entry',
    });

    // Gojek import fixture: all three plates carry money, so visibility in the
    // grid is decided by the plate scope alone.
    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: `${RUN}.csv`, periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    const base = { importId: imp!.id, periodYear: YEAR, periodMonth: MONTH };
    await db.insert(fleetImportDetails).values(
      [PLATE_PARTNER, PLATE_ORPHAN, PLATE_LATE].flatMap((norm) => [
        {
          ...base,
          transactionDate: `${YEAR}-0${MONTH}-03`,
          vehiclePlate: norm,
          vehiclePlateNorm: norm,
          amount: 500_000,
          type: 'Due',
          driverName: 'DRIVER SATU',
        },
        {
          ...base,
          transactionDate: `${YEAR}-0${MONTH}-03`,
          vehiclePlate: norm,
          vehiclePlateNorm: norm,
          amount: -300_000,
          type: 'Deduction',
          driverName: 'DRIVER SATU',
        },
      ]),
    );

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
    partnerAgent = request.agent(app.getHttpServer());
    await partnerAgent
      .post('/partner/portal/login')
      .send({ email: PORTAL_EMAIL, password: PASSWORD })
      .expect(200);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db
      .delete(adminPlates)
      .where(inArray(adminPlates.plateNumberNorm, [PLATE_PARTNER, PLATE_ORPHAN, PLATE_LATE]));
    await db.delete(fleetImports).where(eq(fleetImports.periodYear, YEAR));
    await dropDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(partners).where(eq(partners.id, partnerId)); // cascades partner_plates
    await app.close();
  });

  // ── authorization ────────────────────────────────────────────────────────
  it('is super_admin-only: plain admin 403, partner session 401, anonymous 401', async () => {
    await adminAgent.get('/admin/plates').expect(403);
    await adminAgent.post('/admin/plates').send({ plateNumber: PLATE_ORPHAN }).expect(403);
    // a partner holds no admin session slot → unauthenticated on /admin/*
    await partnerAgent.get('/admin/plates').expect(401);
    await request(app.getHttpServer()).get('/admin/plates').expect(401);
  });

  // ── CRUD ─────────────────────────────────────────────────────────────────
  it('registers a plate (normalizing the input) and rejects blanks + duplicates', async () => {
    const created = await superAgent
      .post('/admin/plates')
      .send({
        plateNumber: ` ${PLATE_ORPHAN.slice(0, 4)} ${PLATE_ORPHAN.slice(4)} `,
        vehicleType: ADMIN_TYPE,
      })
      .expect(201);
    expect(created.body).toMatchObject({
      success: true,
      data: { plateNumberNorm: PLATE_ORPHAN, vehicleType: ADMIN_TYPE, partnerName: null },
    });

    await superAgent.post('/admin/plates').send({ plateNumber: '   ' }).expect(400);
    const dupe = await superAgent.post('/admin/plates').send({ plateNumber: PLATE_ORPHAN });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('CONFLICT');
  });

  it('lists registrations with the partner that registered the same plate', async () => {
    await superAgent.post('/admin/plates').send({ plateNumber: PLATE_PARTNER }).expect(201);

    const res = await superAgent.get('/admin/plates').expect(200);
    const rows = res.body.data as { plateNumberNorm: string; partnerName: string | null }[];
    const byNorm = new Map(rows.map((r) => [r.plateNumberNorm, r]));
    // claimed in a partner portal → the partner's name; admin-only → null
    expect(byNorm.get(PLATE_PARTNER)!.partnerName).toBe(PARTNER_NAME);
    expect(byNorm.get(PLATE_ORPHAN)!.partnerName).toBeNull();
  });

  it('edits and deletes one registration, 404 on an unknown id', async () => {
    const rows = (await superAgent.get('/admin/plates').expect(200)).body.data as {
      id: number;
      plateNumberNorm: string;
    }[];
    const target = rows.find((r) => r.plateNumberNorm === PLATE_PARTNER)!;

    const edited = await superAgent
      .put(`/admin/plates/${target.id}`)
      .send({ plateNumber: PLATE_PARTNER, vehicleType: 'Reguler - Edited' })
      .expect(200);
    expect(edited.body.data.vehicleType).toBe('Reguler - Edited');
    // re-plating onto a norm another row already holds collides
    await superAgent
      .put(`/admin/plates/${target.id}`)
      .send({ plateNumber: PLATE_ORPHAN })
      .expect(409);

    await superAgent.delete(`/admin/plates/${target.id}`).expect(200);
    await superAgent.delete(`/admin/plates/${target.id}`).expect(404);
    const left = (await superAgent.get('/admin/plates').expect(200)).body.data as {
      plateNumberNorm: string;
    }[];
    expect(left.map((r) => r.plateNumberNorm)).not.toContain(PLATE_PARTNER);
  });

  // ── isolation: the admin registry never widens a partner ──────────────────
  it('a plate registered only in /admin stays invisible to the partner', async () => {
    const own = await partnerAgent.get('/partner/portal/plates').expect(200);
    const norms = (own.body.data as { plateNumberNorm: string }[]).map((p) => p.plateNumberNorm);
    expect(norms).toContain(PLATE_PARTNER); // its own registration
    expect(norms).not.toContain(PLATE_ORPHAN); // the admin's

    expect(await gridNorms(partnerAgent, '/partner/portal/fleet/gojek/grid')).not.toContain(
      PLATE_ORPHAN,
    );
  });

  // ── the point of the feature ──────────────────────────────────────────────
  it('an unregistered plate reaches the admin Gojek grid once the admin registers it', async () => {
    expect(await gridNorms(superAgent, '/admin/fleet/gojek/grid')).not.toContain(PLATE_LATE);

    await superAgent
      .post('/admin/plates')
      .send({ plateNumber: PLATE_LATE, vehicleType: ADMIN_TYPE })
      .expect(201);

    const res = await superAgent
      .get(`/admin/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const row = (
      res.body.data.rows as { plateNorm: string; vehicleType: string; rentalPartner: string }[]
    ).find((r) => r.plateNorm === PLATE_LATE);
    expect(row).toBeDefined();
    // the Type typed in Plate Registration fills the row no fleet target set…
    expect(row!.vehicleType).toBe(ADMIN_TYPE);
    // …but an admin registration carries no partner, so the Rental Partner
    // label keeps its existing "no partner" fallback
    expect(row!.rentalPartner).toBe('');

    // and it still is not the partner's business
    expect(await gridNorms(partnerAgent, '/partner/portal/fleet/gojek/grid')).not.toContain(
      PLATE_LATE,
    );
  });
});
