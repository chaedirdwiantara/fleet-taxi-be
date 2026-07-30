/**
 * Date-range summary aggregates (the dashboard's Tanggal filter), Gojek + Grab.
 *
 * The range is a COMPOSITION of monthly grid builds, so the properties worth
 * pinning are the ones that composition promises: a range covering exactly one
 * month equals that month's whole-month totals, adjacent ranges add up to their
 * union, and a range that crosses the month boundary sums both sides — with the
 * balance read at the range's closing date.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
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
} from '../src/db/schema';
import { GojekGridService } from '../src/fleet/gojek-grid.service';
import { buildPeriodSummary } from '../src/fleet/range-summary';
import { GrabGridService } from '../src/grab/grab-grid.service';
import { buildGrabPeriodSummary } from '../src/grab/grab-range-summary';

// A year no other suite touches. It must also be the NEWEST data in the table:
// "driver keluar" keys off MAX(transaction_date) across ALL rows, and an exited
// plate reports under a different total than an active one.
const YEAR = 2039;
const JUL = 7; // 31 days
const AUG = 8;

const SUFFIX = String(Date.now()).slice(-5);
const PLATE = `RS${SUFFIX}A`;

const DAILY_DUE = 100_000;
const JUL_DUE_DAYS = [25, 26, 27, 28, 29, 30, 31]; // 700.000 billed
const JUL_PAID_DAYS = [25, 26]; // 200.000 collected
const AUG_DUE_DAYS = [1, 2, 3, 4, 5]; // 500.000 billed
const AUG_PAID_DAYS = [1]; // 100.000 collected

const GRAB_EARNING = 250_000;
const GRAB_JUL_DAYS = [26, 27];
const GRAB_AUG_DAYS = [2, 3, 4];

const at = (month: number, day: number) =>
  `${YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

describe('Tanggal date-range summary', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let gojek: GojekGridService;
  let grab: GrabGridService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    gojek = app.get(GojekGridService);
    grab = app.get(GrabGridService);
    const { db } = database;

    for (const month of [JUL, AUG]) {
      await ensureDetailPartition(database, 'fleet_import_details', YEAR, month);
      await ensureDetailPartition(database, 'grab_import_details', YEAR, month);
    }

    const imports = new Map<number, number>();
    for (const month of [JUL, AUG]) {
      const [imp] = await db
        .insert(fleetImports)
        .values({
          filename: `range-${month}.csv`,
          periodMonth: month,
          periodYear: YEAR,
          status: 'done',
        })
        .returning();
      imports.set(month, imp!.id);
    }

    const detail = (month: number, day: number, amount: number, type: string) => ({
      importId: imports.get(month)!,
      periodYear: YEAR,
      periodMonth: month,
      transactionDate: at(month, day),
      vehiclePlate: PLATE,
      vehiclePlateNorm: PLATE,
      driverName: PLATE,
      amount,
      type,
    });

    await db.insert(fleetImportDetails).values([
      ...JUL_DUE_DAYS.map((d) => detail(JUL, d, DAILY_DUE, 'Rental fee due')),
      ...JUL_PAID_DAYS.map((d) => detail(JUL, d, -DAILY_DUE, 'Rental fee deduction')),
      ...AUG_DUE_DAYS.map((d) => detail(AUG, d, DAILY_DUE, 'Rental fee due')),
      ...AUG_PAID_DAYS.map((d) => detail(AUG, d, -DAILY_DUE, 'Rental fee deduction')),
    ]);

    const grabImportIds = new Map<number, number>();
    for (const month of [JUL, AUG]) {
      const [imp] = await db
        .insert(grabImports)
        .values({
          filename: `range-${month}.xlsx`,
          periodMonth: month,
          periodYear: YEAR,
          status: 'done',
        })
        .returning();
      grabImportIds.set(month, imp!.id);
    }
    const grabRow = (month: number, day: number) => ({
      importId: grabImportIds.get(month)!,
      periodYear: YEAR,
      periodMonth: month,
      date: at(month, day),
      plateNumber: PLATE,
      plateNumberNorm: PLATE,
      city: 'Jakarta',
      driverName: PLATE,
      totalEarningCollected: GRAB_EARNING,
      totalRides: 4,
      compositeKey: `${PLATE}|Jakarta|${PLATE}`,
    });
    await db
      .insert(grabImportDetails)
      .values([
        ...GRAB_JUL_DAYS.map((d) => grabRow(JUL, d)),
        ...GRAB_AUG_DAYS.map((d) => grabRow(AUG, d)),
      ]);
  });

  afterAll(async () => {
    const { db } = database;
    await db.delete(fleetImportDetails).where(eq(fleetImportDetails.vehiclePlateNorm, PLATE));
    await db.delete(grabImportDetails).where(eq(grabImportDetails.plateNumberNorm, PLATE));
    await db
      .delete(fleetImports)
      .where(inArray(fleetImports.filename, [`range-${JUL}.csv`, `range-${AUG}.csv`]));
    await db
      .delete(grabImports)
      .where(inArray(grabImports.filename, [`range-${JUL}.xlsx`, `range-${AUG}.xlsx`]));
    await app.close();
  });

  const gojekRange = (baseMonth: number, from: string, to: string) =>
    buildPeriodSummary(
      (m, y, dayWindow) => gojek.buildGrid(m, y, { scopePlates: [PLATE], dayWindow }),
      baseMonth,
      YEAR,
      { from, to },
    );

  const grabRange = (baseMonth: number, from: string, to: string) =>
    buildGrabPeriodSummary(
      (m, y, dayWindow) => grab.buildGrid(m, y, { scopePlates: [PLATE], dayWindow }),
      baseMonth,
      YEAR,
      { from, to },
    );

  it('has an active (non-exited) fixture plate — the balance assertions rest on it', async () => {
    const grid = await gojek.buildGrid(AUG, YEAR, { scopePlates: [PLATE] });
    expect(grid.rows.find((r) => r.key === PLATE)!.isExited).toBe(false);
  });

  it('reduces to the whole-month totals when the range covers a full month', async () => {
    const { base, range } = await gojekRange(JUL, at(JUL, 1), at(JUL, 31));
    expect(range!.totalDeduction).toBe(base.totalDeduction);
    expect(range!.totalDue).toBe(base.totalCalculatedTarget);
    expect(range!.outstandingAsOf).toBe(base.totalOutstanding);
    expect(range!.outstandingDelta).toBe(base.totalOutstandingMonth);
  });

  it('sums both sides of a cross-month range and reads the balance at its end', async () => {
    const { range } = await gojekRange(JUL, at(JUL, 25), at(AUG, 5));

    expect(range!.days).toBe(12);
    expect(range!.totalDeduction).toBe(DAILY_DUE * (JUL_PAID_DAYS.length + AUG_PAID_DAYS.length));
    expect(range!.totalDue).toBe(DAILY_DUE * (JUL_DUE_DAYS.length + AUG_DUE_DAYS.length));
    // billed 1.200.000, collected 300.000 -> the range added 900.000 of debt,
    // and with no earlier history that is also the balance at 5 August.
    expect(range!.outstandingDelta).toBe(900_000);
    expect(range!.outstandingAsOf).toBe(900_000);

    // the chart series is continuous across the boundary, keyed by real dates
    expect(range!.charts.daily).toHaveLength(12);
    expect(range!.charts.daily[0]).toEqual({ date: at(JUL, 25), total: DAILY_DUE });
    expect(range!.charts.daily.at(-1)).toEqual({ date: at(AUG, 5), total: 0 });
    expect(range!.charts.daily.map((p) => p.date)).toContain(at(AUG, 1));
  });

  it('is additive: two adjacent ranges equal their union', async () => {
    const [head, tail, whole] = await Promise.all([
      gojekRange(JUL, at(JUL, 25), at(JUL, 31)),
      gojekRange(AUG, at(AUG, 1), at(AUG, 5)),
      gojekRange(JUL, at(JUL, 25), at(AUG, 5)),
    ]);
    expect(head.range!.totalDeduction + tail.range!.totalDeduction).toBe(
      whole.range!.totalDeduction,
    );
    expect(head.range!.totalDue + tail.range!.totalDue).toBe(whole.range!.totalDue);
    expect(head.range!.outstandingDelta + tail.range!.outstandingDelta).toBe(
      whole.range!.outstandingDelta,
    );
    // a balance is not additive — it is the closing one
    expect(whole.range!.outstandingAsOf).toBe(tail.range!.outstandingAsOf);
  });

  it('leaves the whole-month block untouched by the range', async () => {
    const { base, range } = await gojekRange(JUL, at(JUL, 25), at(JUL, 26));
    expect(base.totalCalculatedTarget).toBe(DAILY_DUE * JUL_DUE_DAYS.length); // all of July
    expect(range!.totalDue).toBe(DAILY_DUE * 2);
  });

  it('narrows the Grab totals to the range and stays additive across months', async () => {
    const { base, range } = await grabRange(JUL, at(JUL, 26), at(AUG, 3));
    // July 26-27 + August 2-3 = 4 rows earning
    expect(range!.totalEarning).toBe(GRAB_EARNING * 4);
    expect(range!.activeVehicles).toBe(1);
    expect(range!.charts.daily).toHaveLength(9);
    // the base month keeps its own whole-month totals
    expect(base.totalEarnings).toBe(GRAB_EARNING * GRAB_JUL_DAYS.length);

    const full = await grabRange(JUL, at(JUL, 1), at(JUL, 31));
    expect(full.range!.totalEarning).toBe(full.base.totalEarnings);
  });
});
