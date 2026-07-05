import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { ensureDetailPartition } from '../db/partitions';
import { fleetImportDetails, fleetImports, grabImportDetails, grabImports } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { StorageService } from '../storage/storage.service';
import { readSpreadsheetRows } from './file-reader';
import { IMPORT_QUEUE, ParseJobData, RollbackJobData } from './import.types';
import { GojekRowMapper } from './parsers/gojek.parser';
import { GrabRowMapper } from './parsers/grab.parser';

const BATCH_SIZE = 1000;
const PROGRESS_EVERY = 500;

type Database = DatabaseService['db'];
/** The transaction handle Drizzle passes to `db.transaction(cb)` — same query API. */
type Executor = Parameters<Parameters<Database['transaction']>[0]>[0];

@Processor(IMPORT_QUEUE)
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeGateway,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'parse':
        return this.parse(job.data as ParseJobData);
      case 'rollback':
        return this.rollback(job.data as RollbackJobData);
      default:
        this.logger.warn(`Unknown job: ${job.name}`);
    }
  }

  private async parse(data: ParseJobData): Promise<void> {
    const { platform, importId, periodYear, periodMonth } = data;
    const startedAt = Date.now();
    const importsTable = platform === 'gojek' ? fleetImports : grabImports;
    const { db } = this.database;

    try {
      await db
        .update(importsTable)
        .set({ status: 'processing' })
        .where(eq(importsTable.id, importId));
      // DDL (partition create) must run outside the insert transaction.
      await ensureDetailPartition(
        this.database,
        platform === 'gojek' ? 'fleet_import_details' : 'grab_import_details',
        periodYear,
        periodMonth,
      );

      const buffer = await this.storage.read(data.fileKey);
      // One transaction for the whole file: any failure (bad row, missing
      // header, DB error) atomically rolls back every batch — no orphan rows,
      // no best-effort compensating delete that could silently fail.
      const inserted = await db.transaction((tx) =>
        platform === 'gojek' ? this.parseGojek(tx, data, buffer) : this.parseGrab(tx, data, buffer),
      );

      await db
        .update(importsTable)
        .set({
          status: 'done',
          updatedAt: new Date(),
          ...(platform === 'gojek'
            ? { totalRows: inserted }
            : {
                totalRow: inserted,
                importTimeSeconds: ((Date.now() - startedAt) / 1000).toFixed(2),
              }),
        })
        .where(eq(importsTable.id, importId));

      this.realtime.emitDone({
        importId,
        rowsInserted: inserted,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`import ${importId} (${platform}) failed: ${message}`);
      // The transaction already rolled back every inserted row; just record status.
      await db
        .update(importsTable)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(importsTable.id, importId));
      this.realtime.emitFailed({ importId, error: message });
    }
  }

  private async parseGojek(tx: Executor, data: ParseJobData, buffer: Buffer): Promise<number> {
    const { importId, periodYear, periodMonth } = data;
    const mapper = new GojekRowMapper();
    let batch: (typeof fleetImportDetails.$inferInsert)[] = [];
    let inserted = 0;

    for await (const row of readSpreadsheetRows(buffer, data.kind)) {
      const parsed = mapper.feed(row);
      if (!parsed) continue;
      batch.push({
        importId,
        transactionDate: parsed.transactionDate,
        periodYear,
        periodMonth,
        driverId: parsed.driverId,
        driverName: parsed.driverName,
        vehiclePlate: parsed.vehiclePlate,
        vehiclePlateNorm: parsed.vehiclePlateNorm,
        amount: parsed.amount,
        type: parsed.type,
        isManualPaymentSetoran: parsed.isManualPaymentSetoran,
        referenceId: parsed.referenceId,
      });
      if (batch.length >= BATCH_SIZE) {
        await tx.insert(fleetImportDetails).values(batch);
        inserted += batch.length;
        batch = [];
      }
      if ((inserted + batch.length) % PROGRESS_EVERY === 0) {
        this.emitProgress(importId, inserted + batch.length);
      }
    }
    if (batch.length) {
      await tx.insert(fleetImportDetails).values(batch);
      inserted += batch.length;
    }
    if (!mapper.headerFound) {
      throw new Error('Header row not found — is this a Gojek deduction report?');
    }
    return inserted;
  }

  private async parseGrab(tx: Executor, data: ParseJobData, buffer: Buffer): Promise<number> {
    const { importId, periodYear, periodMonth } = data;
    const mapper = new GrabRowMapper();

    // Legacy dedup: skip rows whose (date, plate, driver) already exist.
    // One partition holds a month of ≤~500 vehicles, so preloading is cheap.
    const existing = await tx
      .select({
        date: grabImportDetails.date,
        plate: grabImportDetails.plateNumber,
        driver: grabImportDetails.driverName,
      })
      .from(grabImportDetails)
      .where(
        and(
          eq(grabImportDetails.periodYear, periodYear),
          eq(grabImportDetails.periodMonth, periodMonth),
        ),
      );
    const seen = new Set(existing.map((r) => `${r.date}|${r.plate ?? ''}|${r.driver ?? ''}`));

    let batch: (typeof grabImportDetails.$inferInsert)[] = [];
    let inserted = 0;

    for await (const row of readSpreadsheetRows(buffer, data.kind)) {
      const parsed = mapper.feed(row);
      if (!parsed) continue;
      const dedupKey = `${parsed.date}|${parsed.plateNumber}|${parsed.driverName}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      batch.push({
        importId,
        date: parsed.date,
        periodYear,
        periodMonth,
        plateNumber: parsed.plateNumber,
        plateNumberNorm: parsed.plateNumberNorm,
        city: parsed.city,
        carModel: parsed.carModel,
        driverName: parsed.driverName,
        driverPhoneNumber: parsed.driverPhoneNumber,
        tiering: parsed.tiering,
        partnerName: parsed.partnerName,
        totalOnlineHours: parsed.totalOnlineHours,
        totalBookings: parsed.totalBookings,
        totalRides: parsed.totalRides,
        cancelByDriver: parsed.cancelByDriver,
        fullfilmentRate: parsed.fullfilmentRate,
        driverCancellationRate: parsed.driverCancellationRate,
        driverFare: parsed.driverFare,
        tollAndOthers: parsed.tollAndOthers,
        totalIncentive: parsed.totalIncentive,
        totalEarningCollected: parsed.totalEarningCollected,
        compositeKey: parsed.compositeKey,
      });
      if (batch.length >= BATCH_SIZE) {
        await tx.insert(grabImportDetails).values(batch);
        inserted += batch.length;
        batch = [];
      }
      if ((inserted + batch.length) % PROGRESS_EVERY === 0) {
        this.emitProgress(importId, inserted + batch.length);
      }
    }
    if (batch.length) {
      await tx.insert(grabImportDetails).values(batch);
      inserted += batch.length;
    }
    if (!mapper.headerFound) {
      throw new Error('Header row not found — is this a Grab statement export?');
    }
    return inserted;
  }

  private emitProgress(importId: number, processed: number): void {
    if (processed === 0) return;
    this.realtime.emitProgress({ importId, processed, total: null, percent: null });
  }

  private async rollback(data: RollbackJobData): Promise<void> {
    const { platform, importId } = data;
    const importsTable = platform === 'gojek' ? fleetImports : grabImports;

    // Deleting the parent cascades its detail rows (FK ON DELETE CASCADE),
    // confined to the period partition. We deliberately do NOT DROP the child
    // partition: across multiple worker instances a DROP could race a
    // concurrent import into the same period and destroy its just-inserted rows.
    await this.database.db.delete(importsTable).where(eq(importsTable.id, importId));
    this.logger.log(`rollback of ${platform} import ${importId} complete`);
  }
}
