/**
 * All Fleet Monitoring (partner portal) + the plate/driver reading mode.
 *
 * Two properties matter here and are asserted directly:
 *  1. The combined matrix agrees with its sources — Σ rows (+ residual) equals
 *     the card totals, and Rental omset equals what Rental Monitoring shows.
 *  2. Reading per driver regroups the SAME rows: setoran, due and the per-day
 *     totals are identical to plate mode, and money that cannot be attributed to
 *     a person (all Rental omset) surfaces in the "Tanpa driver" row instead of
 *     quietly disappearing.
 *
 * Plates and driver names carry a run-unique suffix because the lifecycle scan is
 * all-time and global: e2e files run in parallel against one Postgres.
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
import { ensureDetailPartition } from '../src/db/partitions';
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

const RUN = `af${Date.now()}`;
const SUFFIX = String(Date.now()).slice(-5);
const PASSWORD = 'all-fleet-pw';
const YEAR = 2036;
const MONTH = 5; // 31 days

const PLATE_A = `AF${SUFFIX}A`;
const PLATE_B = `AF${SUFFIX}B`;
const PLATE_OTHER = `AF${SUFFIX}Z`; // another partner's plate — must never leak
const ALL_PLATES = [PLATE_A, PLATE_B, PLATE_OTHER];

const BUDI = `BUDI ${SUFFIX}`; // drives both plates
const ASEP = `ASEP ${SUFFIX}`;
const OTHER_DRIVER = `LAIN ${SUFFIX}`;

// Expected figures, spelled out so a broken aggregate cannot quietly pass.
const GOJEK_A = 400_000; // 300k (day 5) + 100k (day 8, underpaid)
const GOJEK_B = 900_000; // ASEP 300k + 200k, BUDI 400k
const GOJEK_TOTAL = GOJEK_A + GOJEK_B;
const DUE_TOTAL = 1_500_000; // A: 600k · B: 900k
const GRAB_A = 500_000;
const GRAB_B = 400_000;
const GRAB_TOTAL = GRAB_A + GRAB_B;
const RENTAL_TOTAL = 1_300_000; // 3 × 400k + 100k additional cost
const GRAND_TOTAL = GOJEK_TOTAL + GRAB_TOTAL + RENTAL_TOTAL;

type Cell = { gojek: number; grab: number; rental: number; total: number; isZero: boolean };
type Row = {
  key: string;
  label: string;
  sublabel: string | null;
  history: { label: string; sublabel: string | null; fromDay: number; toDay: number }[];
  days: Record<string, Cell>;
  totals: { gojek: number; grab: number; rental: number; total: number };
};
type Grid = {
  mode: 'plate' | 'driver';
  daysInMonth: number;
  rows: Row[];
  residual: Row | null;
  dailyTotals: Record<string, Cell>;
  totals: { gojek: number; grab: number; rental: number; total: number };
  subjectCount: number;
  activeCount: number;
};

describe('All Fleet Monitoring + plate/driver mode', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerId: number;
  let otherPartnerId: number;
  let userId: number;
  const agent = () => request.agent(app.getHttpServer());
  // ONE logged-in agent for the whole suite, and every request awaited in turn.
  // Supertest boots an ephemeral listener per request, so firing several at once
  // (Promise.all over two grid reads) resets connections under CI load.
  let session: request.Agent;

  const login = async () => {
    const a = agent();
    await a
      .post('/partner/portal/login')
      .send({ email: `${RUN}-u@test.example`, password: PASSWORD })
      .expect(200);
    return a;
  };

  const d = (day: number) => `${YEAR}-0${MONTH}-${String(day).padStart(2, '0')}`;

  const allFleet = async (mode?: 'plate' | 'driver'): Promise<Grid> => {
    const query = `month=${MONTH}&year=${YEAR}${mode ? `&mode=${mode}` : ''}`;
    const res = await session.get(`/partner/portal/fleet/all/grid?${query}`).expect(200);
    return res.body.data as Grid;
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
      .values({ code: `${RUN}-P`, name: 'All Fleet Partner', type: 'shuttle' })
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

    await db.insert(partnerPlates).values([
      { partnerId, plateNumber: PLATE_A, plateNumberNorm: PLATE_A, vehicleType: 'Denza' },
      { partnerId, plateNumber: PLATE_B, plateNumberNorm: PLATE_B, vehicleType: 'Air EV' },
      {
        partnerId: otherPartnerId,
        plateNumber: PLATE_OTHER,
        plateNumberNorm: PLATE_OTHER,
        vehicleType: 'Denza',
      },
    ]);

    // ── Gojek: two plates, two drivers, BUDI switches plate mid-month ────────
    // Every subject (plate AND driver) has a row on day 8 so nobody looks
    // "exited" relative to the newest transaction date in this fixture.
    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: 'af.csv', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    const base = { importId: imp!.id, periodYear: YEAR, periodMonth: MONTH };
    const due = (day: number, plate: string, driver: string, amount: number) => ({
      ...base,
      transactionDate: d(day),
      vehiclePlate: plate,
      vehiclePlateNorm: plate,
      driverName: driver,
      type: 'Due',
      amount: -amount,
    });
    const paid = (day: number, plate: string, driver: string, amount: number) => ({
      ...base,
      transactionDate: d(day),
      vehiclePlate: plate,
      vehiclePlateNorm: plate,
      driverName: driver,
      type: 'GoPay Deduction',
      amount: -amount,
    });

    await db.insert(fleetImportDetails).values([
      due(5, PLATE_A, BUDI, 300_000),
      paid(5, PLATE_A, BUDI, 300_000),
      due(8, PLATE_A, BUDI, 300_000),
      paid(8, PLATE_A, BUDI, 100_000), // underpaid → 200k outstanding
      due(5, PLATE_B, ASEP, 300_000),
      paid(5, PLATE_B, ASEP, 300_000),
      due(8, PLATE_B, ASEP, 200_000),
      paid(8, PLATE_B, ASEP, 200_000),
      due(8, PLATE_B, BUDI, 400_000),
      paid(8, PLATE_B, BUDI, 400_000),
      // another partner's plate — scoping must keep it out of every response
      due(5, PLATE_OTHER, OTHER_DRIVER, 900_000),
      paid(5, PLATE_OTHER, OTHER_DRIVER, 900_000),
    ]);

    // ── Grab: one row per plate ──────────────────────────────────────────────
    await ensureDetailPartition(database, 'grab_import_details', YEAR, MONTH);
    const [gimp] = await db
      .insert(grabImports)
      .values({ filename: 'af.xlsx', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    await db.insert(grabImportDetails).values([
      {
        importId: gimp!.id,
        periodYear: YEAR,
        periodMonth: MONTH,
        date: d(5),
        plateNumber: PLATE_A,
        plateNumberNorm: PLATE_A,
        city: 'Jakarta',
        driverName: BUDI,
        totalEarningCollected: GRAB_A,
        totalRides: 8,
        compositeKey: `${PLATE_A}|Jakarta|${BUDI}`,
      },
      {
        importId: gimp!.id,
        periodYear: YEAR,
        periodMonth: MONTH,
        date: d(6),
        plateNumber: PLATE_B,
        plateNumberNorm: PLATE_B,
        city: 'Bandung',
        driverName: ASEP,
        totalEarningCollected: GRAB_B,
        totalRides: 6,
        compositeKey: `${PLATE_B}|Bandung|${ASEP}`,
      },
      {
        importId: gimp!.id,
        periodYear: YEAR,
        periodMonth: MONTH,
        date: d(5),
        plateNumber: PLATE_OTHER,
        plateNumberNorm: PLATE_OTHER,
        city: 'Jakarta',
        driverName: OTHER_DRIVER,
        totalEarningCollected: 700_000,
        totalRides: 4,
        compositeKey: `${PLATE_OTHER}|Jakarta|${OTHER_DRIVER}`,
      },
    ]);

    // ── Rental: one booking on plate A, days 10..12 (+ additional cost) ──────
    await db.insert(rentals).values({
      partnerId,
      plateNumber: PLATE_A,
      plateNumberNorm: PLATE_A,
      vehicleType: 'Denza',
      region: 'Jakarta',
      startDate: d(10),
      endDate: d(12),
      pricePerDay: 400_000,
      additionalCost: 100_000,
      customerName: 'Andi',
      paymentStatus: 'Sudah Dibayar',
    });

    session = await login();
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    // Row deletes only: dropDetailPartition locks the partitioned parent and
    // deadlocks against other suites' cleanup under parallel workers.
    await db
      .delete(fleetImportDetails)
      .where(inArray(fleetImportDetails.vehiclePlateNorm, ALL_PLATES));
    await db
      .delete(grabImportDetails)
      .where(inArray(grabImportDetails.plateNumberNorm, ALL_PLATES));
    await db.delete(fleetImports).where(eq(fleetImports.periodYear, YEAR));
    await db.delete(grabImports).where(eq(grabImports.periodYear, YEAR));
    await db.delete(rentals).where(inArray(rentals.partnerId, [partnerId, otherPartnerId]));
    await db
      .delete(partnerPlates)
      .where(inArray(partnerPlates.partnerId, [partnerId, otherPartnerId]));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(partners).where(inArray(partners.id, [partnerId, otherPartnerId]));
    await app.close();
  });

  it('combines Gojek setoran, Grab earning and Rental omset per plate', async () => {
    const grid = await allFleet();

    expect(grid.mode).toBe('plate');
    expect(grid.daysInMonth).toBe(31);
    expect(grid.rows.map((r) => r.key)).toEqual([PLATE_A, PLATE_B]);

    const a = grid.rows[0];
    expect(a.totals).toEqual({
      gojek: GOJEK_A,
      grab: GRAB_A,
      rental: RENTAL_TOTAL,
      total: GOJEK_A + GRAB_A + RENTAL_TOTAL,
    });
    // day 5 carries both Gojek setoran and Grab earning
    expect(a.days['5']).toMatchObject({ gojek: 300_000, grab: GRAB_A, total: 800_000 });
    // day 10 is rental only, and it is the day the additionalCost is billed
    expect(a.days['10']).toMatchObject({ gojek: 0, grab: 0, rental: 500_000 });
    expect(a.days['11']).toMatchObject({ rental: 400_000 });
    // the registered Type shows as the row sublabel
    expect(a.sublabel).toContain('Denza');
    // drivers of the plate, with the day range they were seen
    expect(a.history.map((h) => h.label)).toEqual([BUDI]);

    expect(grid.rows[1].totals).toEqual({
      gojek: GOJEK_B,
      grab: GRAB_B,
      rental: 0,
      total: GOJEK_B + GRAB_B,
    });
  });

  it('card totals equal Σ rows, and match each source screen', async () => {
    const grid = await allFleet();

    expect(grid.totals).toEqual({
      gojek: GOJEK_TOTAL,
      grab: GRAB_TOTAL,
      rental: RENTAL_TOTAL,
      total: GRAND_TOTAL,
    });
    const summed = grid.rows.reduce(
      (acc, r) => ({
        gojek: acc.gojek + r.totals.gojek,
        grab: acc.grab + r.totals.grab,
        rental: acc.rental + r.totals.rental,
        total: acc.total + r.totals.total,
      }),
      { gojek: 0, grab: 0, rental: 0, total: 0 },
    );
    expect(summed).toEqual(grid.totals);
    expect(grid.residual).toBeNull();

    // Rental agrees with Rental Monitoring's own omset for the month
    const a = session;
    const rentalPage = await a
      .get(`/partner/portal/rentals?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    const omset = (rentalPage.body.data.items as Array<{ omset: number }>).reduce(
      (sum, i) => sum + i.omset,
      0,
    );
    expect(grid.totals.rental).toBe(omset);

    // Gojek agrees with the Gojek grid's own table total
    const gojekGrid = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(grid.totals.gojek).toBe(gojekGrid.body.data.tableTotals.totalDeduction);

    // Grab agrees with the Grab grid's own total
    const grabGrid = await a
      .get(`/partner/portal/fleet/grab/grid?month=${MONTH}&year=${YEAR}`)
      .expect(200);
    expect(grid.totals.grab).toBe(grabGrid.body.data.totals.earning);
  });

  it('driver mode regroups the same money and parks Rental in "Tanpa driver"', async () => {
    const plateMode = await allFleet('plate');
    const driverMode = await allFleet('driver');

    expect(driverMode.mode).toBe('driver');
    expect(driverMode.rows.map((r) => r.label)).toEqual([BUDI, ASEP]);
    expect(driverMode.rows[0].totals).toEqual({
      gojek: 800_000, // 300k + 100k on plate A, 400k on plate B
      grab: GRAB_A,
      rental: 0,
      total: 1_300_000,
    });
    // the mirror-image history column: the plates this person drove
    expect(driverMode.rows[0].history.map((h) => h.label).sort()).toEqual([PLATE_A, PLATE_B]);

    // Rental Monitoring records no driver, so its omset is real but ownerless
    expect(driverMode.residual?.label).toBe('Tanpa driver');
    expect(driverMode.residual?.totals.rental).toBe(RENTAL_TOTAL);

    // …and the grand totals are untouched by the regrouping
    expect(driverMode.totals).toEqual(plateMode.totals);
    expect(driverMode.dailyTotals).toEqual(plateMode.dailyTotals);
  });

  it('counts subjects and earners', async () => {
    const grid = await allFleet();
    expect(grid.subjectCount).toBe(2);
    expect(grid.activeCount).toBe(2);
  });

  it('drills into a cell per source, and 404s on an empty one', async () => {
    const a = session;
    const cell = await a
      .get(`/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=${PLATE_A}&day=5`)
      .expect(200);
    const sources = cell.body.data.sources as Array<{ source: string; total: number }>;
    expect(sources.map((s) => s.source)).toEqual(['gojek', 'grab']);
    expect(sources.find((s) => s.source === 'gojek')!.total).toBe(300_000);
    expect(sources.find((s) => s.source === 'grab')!.total).toBe(GRAB_A);
    expect(cell.body.data.total).toBe(800_000);

    // rental-only day, incl. the additionalCost that lands on the first day
    const rentalCell = await a
      .get(`/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=${PLATE_A}&day=10`)
      .expect(200);
    expect(rentalCell.body.data.sources).toHaveLength(1);
    expect(rentalCell.body.data.sources[0]).toMatchObject({ source: 'rental', total: 500_000 });

    // driver mode: the person's own cell, and the residual row's rental cell
    const driverCell = await a
      .get(
        `/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=${encodeURIComponent(
          `drv:${BUDI}`,
        )}&day=5&mode=driver`,
      )
      .expect(200);
    expect(driverCell.body.data.total).toBe(800_000);

    const residualCell = await a
      .get(
        `/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=residual&day=10&mode=driver`,
      )
      .expect(200);
    expect(residualCell.body.data.label).toBe('Tanpa driver');
    expect(residualCell.body.data.sources[0]).toMatchObject({ source: 'rental', total: 500_000 });

    // a day with nothing on it
    await a
      .get(`/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=${PLATE_A}&day=20`)
      .expect(404);
    // …and a day/key outside the partner's scope
    await a
      .get(`/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=${PLATE_OTHER}&day=5`)
      .expect(404);
    await a
      .get(`/partner/portal/fleet/all/cell?month=${MONTH}&year=${YEAR}&key=${PLATE_A}&day=99`)
      .expect(400);
  });

  it("never leaks another partner's plates or drivers", async () => {
    const plateMode = await allFleet('plate');
    const driverMode = await allFleet('driver');

    expect(plateMode.rows.map((r) => r.key)).not.toContain(PLATE_OTHER);
    expect(driverMode.rows.map((r) => r.label)).not.toContain(OTHER_DRIVER);
    expect(plateMode.totals.total).toBe(GRAND_TOTAL); // no foreign money summed
  });

  it('the Gojek grid in driver mode sums to the same money as plate mode', async () => {
    const a = session;
    const plate = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}&mode=plate`)
      .expect(200);
    const driver = await a
      .get(`/partner/portal/fleet/gojek/grid?month=${MONTH}&year=${YEAR}&mode=driver`)
      .expect(200);

    expect(plate.body.data.mode).toBe('plate');
    expect(driver.body.data.mode).toBe('driver');
    expect(plate.body.data.tableTotals.totalDeduction).toBe(GOJEK_TOTAL);
    expect(driver.body.data.tableTotals.totalDeduction).toBe(GOJEK_TOTAL);
    expect(driver.body.data.tableTotals.totalDue).toBe(plate.body.data.tableTotals.totalDue);
    expect(driver.body.data.tableTotals.totalDue).toBe(DUE_TOTAL);
    expect(driver.body.data.dailyTotals).toEqual(plate.body.data.dailyTotals);

    type GridRow = {
      plateNorm: string;
      driverName: string;
      plateHistory: string[];
      summary: { totalDeduction: number; calculatedTarget: number; outstanding: number };
    };
    const driverRows = driver.body.data.rows as GridRow[];
    expect(driverRows.map((r) => r.plateNorm).sort()).toEqual(
      [`drv:${ASEP}`, `drv:${BUDI}`].sort(),
    );

    // The per-person obligation is the sum of the dues actually billed to them,
    // and the row's balance follows the same rows — 200k underpaid by BUDI.
    const budi = driverRows.find((r) => r.plateNorm === `drv:${BUDI}`)!;
    expect(budi.summary.totalDeduction).toBe(800_000);
    expect(budi.summary.calculatedTarget).toBe(1_000_000);
    expect(budi.summary.outstanding).toBe(200_000);
    expect(budi.plateHistory.sort()).toEqual([PLATE_A, PLATE_B].sort());

    // Outstanding is a property of the rows, so Σ over rows cannot change with
    // the grouping (the exited/active split is subject-level and may differ).
    const sumOutstanding = (rows: GridRow[]) =>
      rows.reduce((sum, r) => sum + r.summary.outstanding, 0);
    expect(sumOutstanding(driverRows)).toBe(sumOutstanding(plate.body.data.rows as GridRow[]));
  });

  it('the Grab grid in driver mode merges a person across plates and cities', async () => {
    const a = session;
    const driver = await a
      .get(`/partner/portal/fleet/grab/grid?month=${MONTH}&year=${YEAR}&mode=driver`)
      .expect(200);

    expect(driver.body.data.mode).toBe('driver');
    expect(driver.body.data.totals.earning).toBe(GRAB_TOTAL);
    const keys = (driver.body.data.rows as Array<{ compositeKey: string }>).map(
      (r) => r.compositeKey,
    );
    expect(keys.sort()).toEqual([`drv:${ASEP}`, `drv:${BUDI}`].sort());
  });

  it('falls back to plate mode on an unknown mode value', async () => {
    const a = session;
    const res = await a
      .get(`/partner/portal/fleet/all/grid?month=${MONTH}&year=${YEAR}&mode=nonsense`)
      .expect(200);
    expect(res.body.data.mode).toBe('plate');
  });
});
