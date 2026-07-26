/**
 * "Total Due (Target)" semantics: the obligation is the sum of the `due` rows
 * that were actually imported — never extrapolated to days that have not
 * elapsed, were never imported, or predate the plate's first appearance.
 *
 * Every grid here is built with an explicit `scopePlates` allowlist so the
 * numbers stay independent of whatever else lives in the shared test database
 * (e2e files run in parallel against one Postgres).
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { fleetExceptions, fleetImportDetails, fleetImports } from '../src/db/schema';
import { ensureDetailPartition } from '../src/db/partitions';
import { toGojekSummary } from '../src/fleet/fleet-presenter';
import { GojekGridService } from '../src/fleet/gojek-grid.service';

const YEAR = 2035;
const MONTH = 7; // 31 days — mirrors the production case
const PREV_MONTH = 6;

// Plates unique to this suite so the all-time lifecycle scan (MIN/MAX over the
// whole table) can never pick up another suite's rows for the same key.
const SUFFIX = String(Date.now()).slice(-5);
const LATE_JOINER = `TD${SUFFIX}A`; // the production B2990UNS shape
const DEADBEAT = `TD${SUFFIX}B`; // operating but not paying
const LEAVER = `TD${SUFFIX}C`; // stops mid-month
const RETURNING = `TD${SUFFIX}D`; // has prior-month history, starts late this month
const WAIVED = `TD${SUFFIX}E`; // bebas-setoran day that still carries a due row
const ALL_PLATES = [LATE_JOINER, DEADBEAT, LEAVER, RETURNING, WAIVED];

describe('Total Due = Σ imported dues', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let gojek: GojekGridService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    gojek = app.get(GojekGridService);
    const { db } = database;

    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    await ensureDetailPartition(database, 'fleet_import_details', YEAR, PREV_MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: 'due.csv', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    const [prevImp] = await db
      .insert(fleetImports)
      .values({
        filename: 'due-prev.csv',
        periodMonth: PREV_MONTH,
        periodYear: YEAR,
        status: 'done',
      })
      .returning();

    const day = (m: number, n: number) =>
      `${YEAR}-${String(m).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    const base = { importId: imp!.id, periodYear: YEAR, periodMonth: MONTH };
    const prevBase = { importId: prevImp!.id, periodYear: YEAR, periodMonth: PREV_MONTH };

    const due = (plate: string, d: number, amount: number, month = MONTH) => ({
      ...(month === MONTH ? base : prevBase),
      transactionDate: day(month, d),
      vehiclePlate: plate,
      vehiclePlateNorm: plate,
      amount,
      type: 'Rental fee due',
      driverName: plate,
    });
    const paid = (plate: string, d: number, amount: number, month = MONTH) => ({
      ...(month === MONTH ? base : prevBase),
      transactionDate: day(month, d),
      vehiclePlate: plate,
      vehiclePlateNorm: plate,
      amount: -amount,
      type: 'Rental fee deduction',
      driverName: plate,
    });

    const rows = [
      // LATE_JOINER: first ever data is d21 of the selected month; dues d21-d24,
      // each fully paid. Days 25-31 have not happened / were not imported.
      ...[21, 22, 23, 24].flatMap((d) => [
        due(LATE_JOINER, d, 423_000),
        paid(LATE_JOINER, d, 423_000),
      ]),

      // DEADBEAT: billed every day d1-d10, pays nothing at all.
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => due(DEADBEAT, d, 400_000)),

      // LEAVER: billed and paying d1-d12, then gone for the rest of the month.
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((d) => [
        due(LEAVER, d, 350_000),
        paid(LEAVER, d, 350_000),
      ]),

      // RETURNING: real history in the previous month, then a late start in the
      // selected one — NOT a new joiner, and days 1-14 are still not billed
      // because no due row exists for them.
      ...[1, 2, 3, 4, 5].flatMap((d) => [
        due(RETURNING, d, 300_000, PREV_MONTH),
        paid(RETURNING, d, 300_000, PREV_MONTH),
      ]),
      ...[15, 16, 17, 18, 19, 20].map((d) => due(RETURNING, d, 300_000)),

      // WAIVED: dues d1-d3; d2 is bebas-setoran AND carries a deduction, so the
      // marker rule ("money wins") and the waiver rule deliberately disagree.
      ...[1, 2, 3].map((d) => due(WAIVED, d, 500_000)),
      paid(WAIVED, 2, 500_000),
    ];
    await db.insert(fleetImportDetails).values(rows);

    await db.insert(fleetExceptions).values([
      {
        vehiclePlate: WAIVED,
        exceptionDate: day(MONTH, 2),
        keterangan: 'Bebas Setoran',
        isBebasSetoran: true,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    // Row deletes only — dropDetailPartition takes an exclusive lock on the
    // partitioned parent and deadlocks against other suites' cleanup when the
    // e2e files run in parallel workers. Empty 2035 partitions are harmless.
    await db
      .delete(fleetImportDetails)
      .where(inArray(fleetImportDetails.vehiclePlateNorm, ALL_PLATES));
    await db.delete(fleetImports).where(eq(fleetImports.periodYear, YEAR));
    await db.delete(fleetExceptions).where(inArray(fleetExceptions.vehiclePlate, ALL_PLATES));
    await app.close();
  });

  const gridFor = (plate: string, day?: number) =>
    gojek.buildGrid(MONTH, YEAR, { scopePlates: [plate], ...(day !== undefined ? { day } : {}) });

  it('bills a mid-month joiner only for the days it was actually billed', async () => {
    // The production report: data exists on 21-24 only, yet the old formula
    // charged 21 → end of month (423.000 × 11 = 4.653.000).
    const grid = await gridFor(LATE_JOINER);
    const row = grid.rows.find((r) => r.key === LATE_JOINER)!;

    expect(row.calculatedTarget).toBe(1_692_000); // 423.000 × 4
    expect(row.billedDays).toBe(4);
    expect(row.billFromDay).toBe(21);
    expect(row.billToDay).toBe(24);
    expect(row.dailyTarget).toBe(423_000);
    expect(row.minDay).toBe(21);
    // fully settled: the gap and the month's outstanding both land on zero
    expect(row.totalDeduction - row.calculatedTarget).toBe(0);
    expect(row.outstandingMonth).toBe(0);
    expect(grid.totalCalculatedTarget).toBe(1_692_000);
  });

  it('marks a plate whose first ever data falls in this month as a new joiner', async () => {
    const grid = await gridFor(LATE_JOINER);
    const row = grid.rows.find((r) => r.key === LATE_JOINER)!;
    expect(row.isNewJoiner).toBe(true);
    expect(row.firstSeen).toBe(`${YEAR}-0${MONTH}-21`);
  });

  it('does not mark a plate with prior-month history as a new joiner, and still bills only its due days', async () => {
    const grid = await gridFor(RETURNING);
    const row = grid.rows.find((r) => r.key === RETURNING)!;

    expect(row.isNewJoiner).toBe(false);
    expect(row.firstSeen).toBe(`${YEAR}-0${PREV_MONTH}-01`);
    // days 1-14 carry no due row -> not billed, even though the plate is not new
    expect(row.calculatedTarget).toBe(300_000 * 6);
    expect(row.billFromDay).toBe(15);
    expect(row.billToDay).toBe(20);
  });

  it('leaves a new joiner with no obligation in the months before it appeared', async () => {
    const prev = await gojek.buildGrid(PREV_MONTH, YEAR, { scopePlates: [LATE_JOINER] });
    expect(prev.rows).toHaveLength(0);
    expect(prev.totalCalculatedTarget).toBe(0);
  });

  it('does not shrink the target for a driver who simply stops paying', async () => {
    const grid = await gridFor(DEADBEAT);
    const row = grid.rows.find((r) => r.key === DEADBEAT)!;

    expect(row.calculatedTarget).toBe(400_000 * 10); // every billed day still counts
    expect(row.totalDeduction).toBe(0);
    expect(row.totalDeduction - row.calculatedTarget).toBe(-4_000_000); // debt stays visible
    expect(row.outstandingMonth).toBe(4_000_000);
  });

  it('stops billing an exited plate at its last billed day, not at month end', async () => {
    const grid = await gridFor(LEAVER);
    const row = grid.rows.find((r) => r.key === LEAVER)!;

    expect(row.calculatedTarget).toBe(350_000 * 12);
    expect(row.billToDay).toBe(12);
    expect(row.outstandingMonth).toBe(0);
  });

  it('waives a bebas-setoran day on both sides, even when it carries money', async () => {
    const grid = await gridFor(WAIVED);
    const row = grid.rows.find((r) => r.key === WAIVED)!;

    // d2's due is waived by the SQL, so the caption must not count it either —
    // the "money wins" marker rule must not leak into the billed span.
    expect(row.calculatedTarget).toBe(1_000_000); // d1 + d3
    expect(row.billedDays).toBe(2);
    expect(row.billFromDay).toBe(1);
    expect(row.billToDay).toBe(3);
    // the marker itself still follows the legacy rule: money on d2 hides it
    expect(row.exceptions[2]).toBeUndefined();
  });

  it('keeps the TS-side per-day dues in step with the SQL-side total', async () => {
    // Pins ABS(), the %due% type match, and the period_year/period_month (pivot)
    // vs transaction_date (aggregate) bucketing against silent divergence.
    for (const plate of [LATE_JOINER, DEADBEAT, LEAVER, RETURNING]) {
      const grid = await gridFor(plate);
      const row = grid.rows.find((r) => r.key === plate)!;
      const sumDailyDue = Object.values(row.dailyDue).reduce((s, v) => s + v, 0);
      expect(sumDailyDue).toBe(row.calculatedTarget);
    }
  });

  it('truncates the Tanggal cutoff to the dues billed on or before that day', async () => {
    const grid = await gridFor(LATE_JOINER, 22);
    const summary = toGojekSummary(grid, 22);

    expect(summary.dayFilter!.cumulative.totalDue).toBe(846_000); // d21 + d22
    expect(summary.globalSummary.totalDue).toBe(1_692_000); // whole month untouched

    // at the last day of the month the cutoff block collapses onto the month
    const full = await gridFor(LATE_JOINER, 31);
    const fullSummary = toGojekSummary(full, 31);
    expect(fullSummary.dayFilter!.cumulative.totalDue).toBe(fullSummary.globalSummary.totalDue);
  });

  it('bills nothing before the first due day even with the cutoff inside that gap', async () => {
    const grid = await gridFor(LATE_JOINER, 20);
    const summary = toGojekSummary(grid, 20);
    expect(summary.dayFilter!.cumulative.totalDue).toBe(0);
  });
});
