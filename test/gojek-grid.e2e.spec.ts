/**
 * Legacy-math fixture tests for the Gojek + Grab grids (M3 deliverable).
 * Every expected number below is hand-computed from the legacy
 * AdminFleetMonitoring(Grab)Controller::getIndex rules. These assert the
 * internal service shape (the math engine); per-partner scoping is covered in
 * partner.e2e.spec.ts. The admin HTTP surface is scoped to the union of every
 * partner's registered plates (partner_plates) — asserted here.
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
import { dropDetailPartition, ensureDetailPartition } from '../src/db/partitions';
import { GojekGridService } from '../src/fleet/gojek-grid.service';
import { GrabGridService } from '../src/grab/grab-grid.service';
import {
  fleetExceptions,
  fleetImportDetails,
  fleetImports,
  fleetTargets,
  grabImportDetails,
  grabImports,
  grabTargets,
  partnerPlates,
  partners,
  roles,
  userRoles,
  users,
} from '../src/db/schema';

const RUN = `grid${Date.now()}`;
const ADMIN_EMAIL = `${RUN}@test.example`;
const PASSWORD = 'grid-test-pw';
const YEAR = 2032;
const MONTH = 5; // 31 days
const GRAB_MONTH = 6;

describe('gojek grid math (ported 1:1 from legacy getIndex)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let gojek: GojekGridService;
  let grab: GrabGridService;
  let agent: ReturnType<typeof request.agent>;
  let adminId: number;
  let partnerAId: number;
  let partnerBId: number;
  const cleanupTargetIds: number[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    gojek = app.get(GojekGridService);
    grab = app.get(GrabGridService);
    const { db } = database;

    // admin session
    await db
      .insert(roles)
      .values([{ name: 'admin' }])
      .onConflictDoNothing();
    const [adminRole] = await db.select().from(roles).where(eq(roles.name, 'admin'));
    const [admin] = await db
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash: await argon2.hash(PASSWORD) })
      .returning();
    adminId = admin!.id;
    await db.insert(userRoles).values({ userId: adminId, roleId: adminRole!.id });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);

    // -- Gojek fixture (period 2032-05) -----------------------------------
    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: 'fixture.csv', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    const importId = imp!.id;

    const d = (day: number) =>
      `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const base = { importId, periodYear: YEAR, periodMonth: MONTH };
    await db.insert(fleetImportDetails).values([
      // G7771KA: dues on 3 & 4 -> inferred target round(950000/2)=475000
      {
        ...base,
        transactionDate: d(3),
        vehiclePlate: 'G 7771 KA',
        vehiclePlateNorm: 'G7771KA',
        amount: 500000,
        type: 'Due',
        driverName: 'BUDI',
      },
      {
        ...base,
        transactionDate: d(4),
        vehiclePlate: 'G 7771 KA',
        vehiclePlateNorm: 'G7771KA',
        amount: 450000,
        type: 'Due',
        driverName: 'BUDI',
      },
      // deductions on 3 & 5 (negative amounts must be ABS'd)
      {
        ...base,
        transactionDate: d(3),
        vehiclePlate: 'G 7771 KA',
        vehiclePlateNorm: 'G7771KA',
        amount: -400000,
        type: 'GoPay Deduction',
        driverName: 'BUDI',
      },
      {
        ...base,
        transactionDate: d(5),
        vehiclePlate: 'G 7771 KA',
        vehiclePlateNorm: 'G7771KA',
        amount: 480000,
        type: 'GoPay Deduction',
        driverName: 'BUDI',
      },
      // manual counted on 6
      {
        ...base,
        transactionDate: d(6),
        vehiclePlate: 'G 7771 KA',
        vehiclePlateNorm: 'G7771KA',
        amount: 100000,
        type: 'Manual Payment',
        isManualPaymentSetoran: 1,
        driverName: 'BUDI',
      },
      // manual UNCOUNTED on 7 (display-only; reduces outstanding directly)
      {
        ...base,
        transactionDate: d(7),
        vehiclePlate: 'G 7771 KA',
        vehiclePlateNorm: 'G7771KA',
        amount: 50000,
        type: 'Manual Payment',
        isManualPaymentSetoran: 0,
        manualPaymentNote: 'promo',
        driverName: 'BUDI',
      },
      // G7772KB: no dues; manual fleet_target wins
      {
        ...base,
        transactionDate: d(10),
        vehiclePlate: 'G 7772 KB',
        vehiclePlateNorm: 'G7772KB',
        amount: 300000,
        type: 'GoPay Deduction',
        driverName: 'SITI',
      },
      // unplated manual payment -> synthetic manual_<id> row
      {
        ...base,
        transactionDate: d(8),
        vehiclePlate: null,
        vehiclePlateNorm: '',
        amount: 75000,
        type: 'Manual Payment',
        isManualPaymentSetoran: 1,
        driverName: 'NOPLAT',
      },
      // G7773KC: has data but is registered by NO partner -> hidden from the
      // admin HTTP surface (and its money from the admin summary)
      {
        ...base,
        transactionDate: d(12),
        vehiclePlate: 'G 7773 KC',
        vehiclePlateNorm: 'G7773KC',
        amount: 250000,
        type: 'GoPay Deduction',
        driverName: 'RUDI',
      },
    ]);

    // two partner accounts; the admin surface is scoped to the UNION of their
    // registered plates (G7771KA from A, G7772KB from B — never G7773KC)
    const [partnerA] = await db
      .insert(partners)
      .values({ code: `${RUN}A`, name: 'Partner A' })
      .returning();
    const [partnerB] = await db
      .insert(partners)
      .values({ code: `${RUN}B`, name: 'Partner B' })
      .returning();
    partnerAId = partnerA!.id;
    partnerBId = partnerB!.id;
    await db.insert(partnerPlates).values([
      {
        partnerId: partnerAId,
        plateNumber: 'G 7771 KA',
        plateNumberNorm: 'G7771KA',
        vehicleType: 'Premium - Innova',
      },
      { partnerId: partnerBId, plateNumber: 'G 7772 KB', plateNumberNorm: 'G7772KB' },
    ]);

    const [target] = await db
      .insert(fleetTargets)
      .values({
        vehiclePlate: 'G7772KB',
        vehiclePlateNorm: 'G7772KB',
        fleetTarget: 300000,
        rentalPartner: `${RUN}-RENTAL`,
      })
      .returning();
    cleanupTargetIds.push(target!.id);

    await db.insert(fleetExceptions).values([
      // day 10 has NO money for G7771KA -> counts as free day
      { vehiclePlate: 'G7771KA', exceptionDate: d(10), keterangan: 'Rental', isBebasSetoran: true },
      // day 5 HAS money -> spreadsheet wins, exception ignored
      {
        vehiclePlate: 'G7771KA',
        exceptionDate: d(5),
        keterangan: 'Perbaikan',
        isBebasSetoran: true,
      },
    ]);

    // -- Grab fixture (period 2032-06) ------------------------------------
    await ensureDetailPartition(database, 'grab_import_details', YEAR, GRAB_MONTH);
    const [gimp] = await db
      .insert(grabImports)
      .values({ filename: 'grab.xlsx', periodMonth: GRAB_MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    const gd = (day: number) => `${YEAR}-0${GRAB_MONTH}-${String(day).padStart(2, '0')}`;
    const gbase = { importId: gimp!.id, periodYear: YEAR, periodMonth: GRAB_MONTH };
    await db.insert(grabImportDetails).values([
      {
        ...gbase,
        date: gd(1),
        plateNumber: 'B 5678 ZZ',
        plateNumberNorm: 'B5678ZZ',
        city: 'Jakarta',
        driverName: 'SITI',
        totalEarningCollected: 100000,
        totalIncentive: 10000,
        driverFare: 90000,
        totalRides: 5,
        totalBookings: 6,
        compositeKey: 'B5678ZZ|Jakarta|SITI',
      },
      {
        ...gbase,
        date: gd(2),
        plateNumber: 'B 5678 ZZ',
        plateNumberNorm: 'B5678ZZ',
        city: 'Jakarta',
        driverName: 'SITI',
        totalEarningCollected: 200000,
        totalIncentive: 20000,
        driverFare: 180000,
        totalRides: 7,
        totalBookings: 8,
        compositeKey: 'B5678ZZ|Jakarta|SITI',
      },
    ]);
    await db
      .insert(grabTargets)
      .values({ plateNumber: 'B5678ZZ', rentalPartner: `${RUN}-GRENTAL` });
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db.delete(fleetImports).where(eq(fleetImports.periodYear, YEAR));
    await db.delete(grabImports).where(eq(grabImports.periodYear, YEAR));
    await dropDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    await dropDetailPartition(database, 'grab_import_details', YEAR, GRAB_MONTH);
    await db.delete(fleetTargets).where(inArray(fleetTargets.id, cleanupTargetIds));
    await db.delete(grabTargets).where(eq(grabTargets.plateNumber, 'B5678ZZ'));
    await db.delete(fleetExceptions).where(eq(fleetExceptions.vehiclePlate, 'G7771KA'));
    // cascades to partner_plates
    await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    await db.delete(users).where(eq(users.id, adminId));
    await app.close();
  });

  it('computes inferred daily target, calculated target and outstanding for G7771KA', async () => {
    const grid = await gojek.buildGrid(MONTH, YEAR);
    const row = grid.rows.find((r) => r.key === 'G7771KA');
    expect(row).toBeDefined();

    // inferred: no manual target -> round(950000/2) = 475000
    expect(row!.dailyTarget).toBe(475000);
    // counted month total: 400000+480000 deductions + 100000 manual counted
    expect(row!.totalDeduction).toBe(980000);
    // display total also includes the uncounted 50000
    expect(row!.totalDisplayAmount).toBe(1030000);
    // active range: min from due day 3 (uncounted manual on 7 must NOT extend range beyond counted 6)
    expect(row!.minDay).toBe(3);
    // targetDays = (31 - 3 + 1) - 1 free-day exception = 28 -> 475000 x 28
    expect(row!.calculatedTarget).toBe(475000 * 28);
    // exception on day 5 ignored (money present); day 10 kept
    expect(row!.exceptions[10]).toBeDefined();
    expect(row!.exceptions[5]).toBeUndefined();
    // cumulative outstanding = Σ due − Σ paid up to end of month, skipping
    // bebas-setoran days entirely: 950000 − (400000 + 100000 + 50000) = 400000
    // (the day-5 480000 deduction sits on a bebas-setoran day → not credited)
    expect(row!.outstanding).toBe(400000);
    // only month of data → the month delta equals the cumulative balance
    expect(row!.outstandingMonth).toBe(400000);
    // daily cells
    expect(row!.dailyData[7]).toBe(50000); // display
    expect(row!.dailyCountedData[7]).toBe(0); // uncounted
    expect(row!.manualPaymentDisplayOnlyDays).toContain(7);
    // per-day due target + its RLE segments (target changed between day 3 and 4)
    expect(row!.dailyDue).toEqual({ 3: 500000, 4: 450000 });
    expect(row!.dueSegments).toEqual([
      { amount: 500000, fromDay: 3, toDay: 3 },
      { amount: 450000, fromDay: 4, toDay: 4 },
    ]);
  });

  it('manual fleet_target wins over inference for G7772KB', async () => {
    const grid = await gojek.buildGrid(MONTH, YEAR);
    const row = grid.rows.find((r) => r.key === 'G7772KB');
    expect(row!.dailyTarget).toBe(300000);
    expect(row!.rentalPartner).toBe(`${RUN}-RENTAL`);
    // minDay 10 -> targetDays 22 -> 300000 x 22
    expect(row!.calculatedTarget).toBe(300000 * 22);
    // no due rows ever → cumulative outstanding = 0 − 300000 (overpaid credit)
    expect(row!.outstanding).toBe(-300000);
    expect(row!.outstandingMonth).toBe(-300000);
  });

  it('diverts unplated manual payments into the rawRows queue (Data Mentah Tanpa Plat)', async () => {
    const grid = await gojek.buildGrid(MONTH, YEAR);
    // no synthetic manual_<id> rows in the pivot anymore
    expect(grid.rows.some((r) => r.key.startsWith('manual_'))).toBe(false);
    const raw = grid.rawRows.find((r) => r.driverName === 'NOPLAT');
    expect(raw).toBeDefined();
    expect(raw!.detailId).toBeGreaterThan(0);
    expect(raw!.amount).toBe(75000);
    expect(raw!.transactionDate).toBe(`${YEAR}-0${MONTH}-08`);
    expect(raw!.isManualPaymentSetoran).toBe(1);
    expect(grid.rawTotalAmount).toBeGreaterThanOrEqual(75000);
  });

  it('serves the cell-click breakdown', async () => {
    const bucket = await gojek.getCell(MONTH, YEAR, 'G7771KA', 7);
    expect(bucket).not.toBeNull();
    expect(bucket!.displayTotal).toBe(50000);
    expect(bucket!.countedTotal).toBe(0);
    expect(bucket!.hasDisplayOnlyManualPayment).toBe(true);
    expect(bucket!.items[0]!.label).toBe('Manual Payment (Tidak Masuk Setoran)');
    expect(bucket!.items[0]!.note).toBe('promo');
  });

  it('filters by rental partner incl. "(Tanpa Rental Partner)"', async () => {
    const only = await gojek.buildGrid(MONTH, YEAR, { rentalPartners: [`${RUN}-RENTAL`] });
    expect(only.rows).toHaveLength(1);
    expect(only.rows[0]!.key).toBe('G7772KB');

    const none = await gojek.buildGrid(MONTH, YEAR, {
      rentalPartners: ['(Tanpa Rental Partner)'],
    });
    const keys = none.rows.map((r) => r.key);
    expect(keys).toContain('G7771KA');
    expect(keys).not.toContain('G7772KB');
  });

  it('scopePlates restricts the grid to an allowlist (partner scoping primitive)', async () => {
    const scoped = await gojek.buildGrid(MONTH, YEAR, { scopePlates: ['G7772KB'] });
    const keys = scoped.rows.map((r) => r.key);
    expect(keys).toContain('G7772KB');
    expect(keys).not.toContain('G7771KA');

    // an empty allowlist yields an empty grid (partner with no registered plates)
    const empty = await gojek.buildGrid(MONTH, YEAR, { scopePlates: [] });
    expect(empty.rows).toHaveLength(0);
    expect(empty.totalOutstanding).toBe(0);
  });

  it('flags driver keluar and partitions outstanding into the card (scoped for determinism)', async () => {
    // G7771KA's newest row is day 7 while the newest import date anywhere is
    // later (G7772KB has day 10) -> exited. Scoping to the one plate makes the
    // card sums independent of unrelated data in the shared test database.
    const grid = await gojek.buildGrid(MONTH, YEAR, { scopePlates: ['G7771KA'] });
    const row = grid.rows.find((r) => r.key === 'G7771KA');
    expect(row!.isExited).toBe(true);
    expect(row!.exitedLastSeen).toBe(`${YEAR}-0${MONTH}-07`);

    // all-time balance: due 950000 − paid (400000 + 100000 + 50000); the day-5
    // 480000 deduction sits on a bebas-setoran day and is skipped entirely
    expect(grid.outstandingDriverKeluar).toBe(400000);
    expect(grid.exitedCount).toBe(1);
    // the exited row's outstanding leaves the main total (cards partition it)
    expect(grid.totalOutstanding).toBe(0);
  });

  it('builds the Grab composite-key pivot with summed summary columns', async () => {
    const grid = await grab.buildGrid(GRAB_MONTH, YEAR);
    const row = grid.rows.find((r) => r.key === 'B5678ZZ|Jakarta|SITI');
    expect(row).toBeDefined();
    expect(row!.dailyData[1]).toBe(100000);
    expect(row!.dailyData[2]).toBe(200000);
    expect(row!.totalEarningCollected).toBe(300000);
    expect(row!.totalIncentive).toBe(30000);
    expect(row!.totalRides).toBe(12);
    expect(row!.details.bookings).toBe(14);
    expect(row!.rentalPartner).toBe(`${RUN}-GRENTAL`);
    expect(grid.totalEarnings).toBe(300000);
  });

  it('upserts and reads target metadata via /targets/:plate', async () => {
    await agent
      .put(`/admin/fleet/gojek/targets/B 3333 CC`)
      .send({ fleetTarget: 520000, rentalPartner: `${RUN}-NEW` })
      .expect(200);
    const res = await agent.get(`/admin/fleet/gojek/targets/B3333CC`).expect(200);
    expect(res.body.data.fleetTarget).toBe(520000);
    expect(res.body.data.vehiclePlateNorm).toBe('B3333CC');
    // cleanup
    await database.db.delete(fleetTargets).where(eq(fleetTargets.vehiclePlateNorm, 'B3333CC'));
  });

  it('validates the target upsert body (concrete DTO, not an inert intersection)', async () => {
    // non-numeric fleetTarget must be rejected by the global ValidationPipe
    const bad = await agent
      .put(`/admin/fleet/gojek/targets/B4444DD`)
      .send({ fleetTarget: 'abc' })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    // unknown properties must be stripped/rejected (forbidNonWhitelisted)
    await agent.put(`/admin/fleet/gojek/targets/B4444DD`).send({ hacker: true }).expect(400);
  });

  it('manages exceptions via CRUD endpoints', async () => {
    const created = await agent
      .post('/admin/fleet/gojek/exceptions')
      .send({
        vehiclePlate: 'B 9999 XX',
        exceptionDate: `${YEAR}-05-20`,
        keterangan: 'Service',
        isBebasSetoran: true,
      })
      .expect(201);
    const id = created.body.data.id as number;

    const list = await agent
      .get(`/admin/fleet/gojek/exceptions?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(list.body.data.some((e: { id: number }) => e.id === id)).toBe(true);

    await agent.delete(`/admin/fleet/gojek/exceptions/${id}`).expect(200);
  });

  it('scopes the admin grid to the union of every partner’s registered plates (HTTP)', async () => {
    const res = await agent.get(`/admin/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`).expect(200);
    const norms = res.body.data.rows.map((r: { plateNorm: string }) => r.plateNorm);
    // one plate registered by partner A, the other by partner B
    expect(norms).toContain('G7771KA');
    expect(norms).toContain('G7772KB');
    // registered by no partner -> hidden, incl. unplated manual_<id> rows
    expect(norms).not.toContain('G7773KC');
    expect(norms.some((n: string) => n.startsWith('manual_'))).toBe(false);
    // ...but the unplated manual payment still reaches the admin processing
    // queue (Data Mentah Tanpa Plat) even under the union scope
    const raw = res.body.data.rawRows as Array<{ driverName: string; amount: number }>;
    expect(raw.some((r) => r.driverName === 'NOPLAT' && r.amount === 75000)).toBe(true);
    // the Type entered in Daftarkan Plat surfaces when no fleet target set one
    const rowA = res.body.data.rows.find((r: { plateNorm: string }) => r.plateNorm === 'G7771KA');
    expect(rowA.vehicleType).toBe('Premium - Innova');
  });

  it('admin summary counts only the plates visible in the scoped table (HTTP)', async () => {
    const res = await agent
      .get(`/admin/fleet/gojek/summary?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    // G7771KA (980000) + G7772KB (300000); G7773KC (250000) and the unplated
    // manual payment (75000) are outside the table, so outside the summary too
    expect(res.body.data.globalSummary.totalDeduction).toBe(1_280_000);
  });

  it('admin cell 404s for a plate no partner registered (HTTP)', async () => {
    await agent
      .get(`/admin/fleet/gojek/cell?month=${MONTH}&year=${YEAR}&plate=G7773KC&day=12`)
      .expect(404);
    // registered plates keep serving the breakdown modal
    const res = await agent
      .get(`/admin/fleet/gojek/cell?month=${MONTH}&year=${YEAR}&plate=G7771KA&day=7`)
      .expect(200);
    expect(res.body.data.displayTotal).toBe(50000);
  });

  it('GET /details/:detailId prefills the manual-payment detail', async () => {
    const grid = await gojek.buildGrid(MONTH, YEAR);
    const manual = grid.rawRows.find((r) => r.driverName === 'NOPLAT')!;
    const res = await agent
      .get(`/admin/fleet/gojek/details/${manual.detailId}?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(res.body.data.isManualPayment).toBe(true);
    expect(res.body.data.driverName).toBe('NOPLAT');
    expect(res.body.data.isManualPaymentSetoran).toBe(1);
  });

  // MUTATING — keep last: it consumes the raw manual row for this fixture.
  it('POST /edit-driver assigns a plate to a manual row, merging it into that plate', async () => {
    const before = await gojek.buildGrid(MONTH, YEAR);
    const manual = before.rawRows.find((r) => r.driverName === 'NOPLAT')!;

    const res = await agent
      .post('/admin/fleet/gojek/edit-driver')
      .send({
        detailId: manual.detailId,
        month: MONTH,
        year: YEAR,
        driverName: 'NOPLAT',
        vehiclePlate: 'B 8888 MP',
        isManualPaymentSetoran: 1,
      })
      .expect(200);
    expect(res.body.data.updated).toBe(1);

    const after = await gojek.buildGrid(MONTH, YEAR);
    // the raw queue entry is gone; the detail now lives under its plate
    expect(after.rawRows.find((r) => r.detailId === manual.detailId)).toBeUndefined();
    const merged = after.rows.find((r) => r.key === 'B8888MP');
    expect(merged).toBeDefined();
    expect(merged!.dailyData[8]).toBe(75000); // the manual amount, now on its plate

    // B8888MP is registered by no partner, so the admin surface still hides it
    const http = await agent.get(`/admin/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`).expect(200);
    const norms = http.body.data.rows.map((r: { plateNorm: string }) => r.plateNorm);
    expect(norms).not.toContain('B8888MP');
  });
});
