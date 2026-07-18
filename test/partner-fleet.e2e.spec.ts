/**
 * Partner portal fleet-monitoring (Daftarkan Plat + scoped Gojek/Grab grids).
 * A partner sees ONLY the plates it registered — the plate allowlist is derived
 * from the session partnerId, never from client input. Needs docker-compose
 * Postgres + Redis and applied migrations.
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
import { dropDetailPartition, ensureDetailPartition } from '../src/db/partitions';
import {
  fleetImportDetails,
  fleetImports,
  grabImportDetails,
  grabImports,
  partnerPlates,
  partners,
  rentals,
  roles,
  userRoles,
  users,
} from '../src/db/schema';

const RUN = `pf${Date.now()}`;
const PASSWORD = 'partner-fleet-pw';
const YEAR = 2033;
const MONTH = 4; // 30 days
const MINE_NORM = 'B1111AA';
const OTHER_NORM = 'B2222BB';

describe('partner portal fleet monitoring (Daftarkan Plat + scoped grids)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerId: number;
  let otherPartnerId: number;
  let userId: number;
  const agent = () => request.agent(app.getHttpServer());

  const login = async () => {
    const a = agent();
    await a
      .post('/partner/portal/login')
      .send({ email: `${RUN}-u@test.example`, password: PASSWORD })
      .expect(200);
    return a;
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
      .values([{ name: 'partner' }])
      .onConflictDoNothing();
    const [partnerRole] = await db.select().from(roles).where(eq(roles.name, 'partner'));

    const [p] = await db
      .insert(partners)
      .values({ code: `${RUN}-P`, name: 'Fleet Partner', type: 'shuttle' })
      .returning();
    const [other] = await db
      .insert(partners)
      .values({ code: `${RUN}-O`, name: 'Other Partner', type: 'shuttle' })
      .returning();
    partnerId = p!.id;
    otherPartnerId = other!.id;

    const [u] = await db
      .insert(users)
      .values({
        email: `${RUN}-u@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        partnerId,
      })
      .returning();
    userId = u!.id;
    await db.insert(userRoles).values({ userId, roleId: partnerRole!.id });

    // Admin-imported fleet data: MINE (registerable) + OTHER (not the partner's).
    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: 'f.csv', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    const d = (day: number) => `${YEAR}-0${MONTH}-${String(day).padStart(2, '0')}`;
    const base = { importId: imp!.id, periodYear: YEAR, periodMonth: MONTH };
    await db.insert(fleetImportDetails).values([
      {
        ...base,
        transactionDate: d(5),
        vehiclePlate: 'B 1111 AA',
        vehiclePlateNorm: MINE_NORM,
        amount: -300000,
        type: 'GoPay Deduction',
        driverName: 'MINE DRIVER',
      },
      {
        ...base,
        transactionDate: d(6),
        vehiclePlate: 'B 1111 AA',
        vehiclePlateNorm: MINE_NORM,
        amount: -300000,
        type: 'GoPay Deduction',
        driverName: 'MINE DRIVER',
      },
      {
        ...base,
        transactionDate: d(5),
        vehiclePlate: 'B 2222 BB',
        vehiclePlateNorm: OTHER_NORM,
        amount: -300000,
        type: 'GoPay Deduction',
        driverName: 'OTHER DRIVER',
      },
    ]);

    await ensureDetailPartition(database, 'grab_import_details', YEAR, MONTH);
    const [gimp] = await db
      .insert(grabImports)
      .values({ filename: 'g.xlsx', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    await db.insert(grabImportDetails).values([
      {
        importId: gimp!.id,
        periodYear: YEAR,
        periodMonth: MONTH,
        date: d(5),
        plateNumber: 'B 1111 AA',
        plateNumberNorm: MINE_NORM,
        city: 'Jakarta',
        driverName: 'MINE DRIVER',
        totalEarningCollected: 500000,
        totalRides: 8,
        compositeKey: `${MINE_NORM}|Jakarta|MINE DRIVER`,
      },
      {
        importId: gimp!.id,
        periodYear: YEAR,
        periodMonth: MONTH,
        date: d(5),
        plateNumber: 'B 2222 BB',
        plateNumberNorm: OTHER_NORM,
        city: 'Jakarta',
        driverName: 'OTHER DRIVER',
        totalEarningCollected: 400000,
        totalRides: 6,
        compositeKey: `${OTHER_NORM}|Jakarta|OTHER DRIVER`,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db
      .delete(partnerPlates)
      .where(inArray(partnerPlates.partnerId, [partnerId, otherPartnerId]));
    await db.delete(fleetImports).where(eq(fleetImports.periodYear, YEAR));
    await db.delete(grabImports).where(eq(grabImports.periodYear, YEAR));
    await dropDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    await dropDetailPartition(database, 'grab_import_details', YEAR, MONTH);
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(partners).where(inArray(partners.id, [partnerId, otherPartnerId]));
    await app.close();
  });

  it('with no registered plates: empty plate list, empty grid, Rp 0 summary', async () => {
    const a = await login();
    expect((await a.get('/partner/portal/plates').expect(200)).body.data).toEqual([]);

    const grid = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(grid.body.data.rows).toEqual([]);
    expect(grid.body.data.tableTotals.totalDeduction).toBe(0);

    const summary = await a
      .get(`/partner/portal/fleet/gojek/summary?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(summary.body.data.globalSummary).toEqual({
      totalDeduction: 0,
      totalDue: 0,
      totalOutstanding: 0,
      outstandingDriverKeluar: 0,
      exitedCount: 0,
    });
  });

  it('registers a plate (nomor + Type), normalizing, and rejects duplicates', async () => {
    const a = await login();
    const created = await a
      .post('/partner/portal/plates')
      .send({ plateNumber: 'B 1111 AA', vehicleType: 'Premium - BYD M6' })
      .expect(201);
    expect(created.body.data.plateNumberNorm).toBe(MINE_NORM);
    expect(created.body.data.vehicleType).toBe('Premium - BYD M6');

    const list = await a.get('/partner/portal/plates').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].plateNumber).toBe('B 1111 AA');

    // same plate again (even differently spaced) → conflict
    await a.post('/partner/portal/plates').send({ plateNumber: 'b1111aa' }).expect(409);
    // blank/garbage plate → 400
    await a.post('/partner/portal/plates').send({ plateNumber: '   ' }).expect(400);
  });

  it('marks Rental Monitoring days on the Gojek grid (money wins, target shrinks)', async () => {
    const { db } = database;
    const d = (day: number) => `${YEAR}-0${MONTH}-${String(day).padStart(2, '0')}`;
    await db.insert(rentals).values({
      partnerId,
      plateNumber: 'B 1111 AA',
      plateNumberNorm: MINE_NORM,
      startDate: d(5), // day 5 has spreadsheet money -> money wins, no marker
      endDate: d(8),
      pricePerDay: 400000,
      customerName: 'Andi',
    });

    const a = await login();
    const grid = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const mine = grid.body.data.rows.find((r: { plateNorm: string }) => r.plateNorm === MINE_NORM);

    // rental days render through the exception channel like legacy bebas-setoran
    expect(mine.days['7'].exception).toEqual({
      isBebasSetoran: true,
      keterangan: 'Rental — Andi',
    });
    expect(mine.days['8'].exception?.isBebasSetoran).toBe(true);
    // deposit money on days 5 & 6 wins over the rental marker
    expect(mine.days['5'].exception ?? null).toBeNull();
    expect(mine.days['6'].exception ?? null).toBeNull();
    expect(mine.days['5'].countedAmount).toBe(300000);
    // bebas days shrink the expected target: 2 marker days (7, 8) excluded
    const remainingDays = 30 - 5 + 1; // minDay 5, April = 30 days
    expect(mine.summary.calculatedTarget).toBe(mine.dailyTarget * (remainingDays - 2));

    await db.delete(rentals).where(eq(rentals.partnerId, partnerId));
  });

  it('scopes the Gojek grid + summary to registered plates only', async () => {
    const a = await login();
    const grid = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const keys = grid.body.data.rows.map((r: { plateNorm: string }) => r.plateNorm);
    expect(keys).toContain(MINE_NORM);
    expect(keys).not.toContain(OTHER_NORM);

    // presenter shape: per-day facts + summary object (display-only)
    const mine = grid.body.data.rows.find((r: { plateNorm: string }) => r.plateNorm === MINE_NORM);
    expect(mine.summary.totalDeduction).toBe(600000);
    expect(mine.days['5'].countedAmount).toBe(300000);
    // the Type registered in Daftarkan Plat surfaces on the grid (no admin
    // fleet target set it) — the PortalFleetService overlay.
    expect(mine.vehicleType).toBe('Premium - BYD M6');

    const summary = await a
      .get(`/partner/portal/fleet/gojek/summary?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(summary.body.data.globalSummary.totalDeduction).toBe(600000);
    expect(summary.body.data.driverActivity).toBeDefined();
    expect(summary.body.data.charts.daily).toHaveLength(30);
  });

  it('edits a registered plate Type (PUT) and the grid overlay follows', async () => {
    const a = await login();
    const id = (await a.get('/partner/portal/plates').expect(200)).body.data[0].id;

    const updated = await a
      .put(`/partner/portal/plates/${id}`)
      .send({ plateNumber: 'B 1111 AA', vehicleType: 'Reguler - Xenia' })
      .expect(200);
    expect(updated.body.data.plateNumberNorm).toBe(MINE_NORM);
    expect(updated.body.data.vehicleType).toBe('Reguler - Xenia');

    const grid = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const mine = grid.body.data.rows.find((r: { plateNorm: string }) => r.plateNorm === MINE_NORM);
    expect(mine.vehicleType).toBe('Reguler - Xenia');

    // restore for the later delete test's expectations
    await a
      .put(`/partner/portal/plates/${id}`)
      .send({ plateNumber: 'B 1111 AA', vehicleType: 'Premium - BYD M6' })
      .expect(200);
  });

  it('scopes the Grab grid and blocks cell access to unregistered plates', async () => {
    const a = await login();
    const grab = await a
      .get(`/partner/portal/fleet/grab/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const plates = grab.body.data.rows.map((r: { plateNumber: string }) => r.plateNumber);
    expect(plates).toContain(MINE_NORM);
    expect(plates).not.toContain(OTHER_NORM);

    // a partner cannot drill into a plate it never registered
    await a
      .get(`/partner/portal/fleet/gojek/cell?month=${MONTH}&year=${YEAR}&plate=${OTHER_NORM}&day=5`)
      .expect(404);
    await a
      .get(`/partner/portal/fleet/gojek/cell?month=${MONTH}&year=${YEAR}&plate=${MINE_NORM}&day=5`)
      .expect(200);
  });

  it('deleting a plate is partner-scoped and empties the grid again', async () => {
    const a = await login();
    const list = await a.get('/partner/portal/plates').expect(200);
    const id = list.body.data[0].id as number;

    // another partner's session cannot delete this plate (scoped by partnerId)
    const { db } = database;
    const [otherUser] = await db
      .insert(users)
      .values({
        email: `${RUN}-o@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        partnerId: otherPartnerId,
      })
      .returning();
    const [partnerRole] = await db.select().from(roles).where(eq(roles.name, 'partner'));
    await db.insert(userRoles).values({ userId: otherUser!.id, roleId: partnerRole!.id });
    const other = agent();
    await other
      .post('/partner/portal/login')
      .send({ email: `${RUN}-o@test.example`, password: PASSWORD })
      .expect(200);
    await other.delete(`/partner/portal/plates/${id}`).expect(404);

    // the owner can delete it
    await a.delete(`/partner/portal/plates/${id}`).expect(200);
    const grid = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(grid.body.data.rows).toEqual([]);

    await db.delete(users).where(eq(users.id, otherUser!.id));
  });
});
