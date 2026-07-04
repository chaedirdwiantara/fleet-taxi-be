import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { and, count, eq, ne } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { dropDetailPartition, ensureDetailPartition } from '../db/partitions';
import { fleetImportDetails, fleetImports, grabImportDetails, grabImports } from '../db/schema';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { StorageService } from '../storage/storage.service';
import { readSpreadsheetRows } from './file-reader';
import { IMPORT_QUEUE, ParseJobData, RollbackJobData } from './import.types';
import { GojekRowMapper } from './parsers/gojek.parser';
import { GrabRowMapper } from './parsers/grab.parser';

const BATCH_SIZE = 1000;
const PROGRESS_EVERY = 500;

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
      await ensureDetailPartition(
        this.database,
        platform === 'gojek' ? 'fleet_import_details' : 'grab_import_details',
        periodYear,
        periodMonth,
      );

      const buffer = await this.storage.read(data.fileKey);
      const inserted =
        platform === 'gojek'
          ? await this.parseGojek(data, buffer)
          : await this.parseGrab(data, buffer);

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
      // Roll back this batch's rows — isolated by import_id inside one partition
      const detailsTable = platform === 'gojek' ? fleetImportDetails : grabImportDetails;
      await db
        .delete(detailsTable)
        .where(eq(detailsTable.importId, importId))
        .catch(() => undefined);
      await db
        .update(importsTable)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(importsTable.id, importId));
      this.realtime.emitFailed({ importId, error: message });
    }
  }

  private async parseGojek(data: ParseJobData, buffer: Buffer): Promise<number> {
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
        await this.database.db.insert(fleetImportDetails).values(batch);
        inserted += batch.length;
        batch = [];
      }
      if ((inserted + batch.length) % PROGRESS_EVERY === 0) {
        this.emitProgress(importId, inserted + batch.length);
      }
    }
    if (batch.length) {
      await this.database.db.insert(fleetImportDetails).values(batch);
      inserted += batch.length;
    }
    if (!mapper.headerFound) {
      throw new Error('Header row not found — is this a Gojek deduction report?');
    }
    return inserted;
  }

  private async parseGrab(data: ParseJobData, buffer: Buffer): Promise<number> {
    const { importId, periodYear, periodMonth } = data;
    const mapper = new GrabRowMapper();
    const { db } = this.database;

    // Legacy dedup: skip rows whose (date, plate, driver) already exist.
    // One partition holds a month of ≤~500 vehicles, so preloading is cheap.
    const existing = await db
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
        await db.insert(grabImportDetails).values(batch);
        inserted += batch.length;
        batch = [];
      }
      if ((inserted + batch.length) % PROGRESS_EVERY === 0) {
        this.emitProgress(importId, inserted + batch.length);
      }
    }
    if (batch.length) {
      await db.insert(grabImportDetails).values(batch);
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
    const { platform, importId, periodYear, periodMonth } = data;
    const importsTable = platform === 'gojek' ? fleetImports : grabImports;
    const detailTableName = platform === 'gojek' ? 'fleet_import_details' : 'grab_import_details';
    const { db } = this.database;

    // Parent delete cascades details (FK ON DELETE CASCADE), pruned to one partition
    await db.delete(importsTable).where(eq(importsTable.id, importId));

    // Fast path: if no other import batch remains for this period, drop the child partition
    const [remaining] = await db
      .select({ n: count() })
      .from(importsTable)
      .where(
        and(
          eq(importsTable.periodYear, periodYear),
          eq(importsTable.periodMonth, periodMonth),
          ne(importsTable.id, importId),
        ),
      );
    if (remaining && Number(remaining.n) === 0) {
      await dropDetailPartition(this.database, detailTableName, periodYear, periodMonth).catch(
        () => undefined,
      );
      // recreate lazily on next import via ensureDetailPartition
    }

    this.logger.log(`rollback of ${platform} import ${importId} complete`);
  }
}
