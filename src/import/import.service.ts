import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from '../db/database.service';
import { fleetImports, grabImports, users } from '../db/schema';
import { StorageService } from '../storage/storage.service';
import { detectKind } from './file-reader';
import { IMPORT_QUEUE, ParseJobData, Platform, RollbackJobData } from './import.types';

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;

@Injectable()
export class ImportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    @InjectQueue(IMPORT_QUEUE) private readonly queue: Queue,
  ) {}

  private importsTable(platform: Platform) {
    return platform === 'gojek' ? fleetImports : grabImports;
  }

  /**
   * Normalize an import row into ONE consistent batch shape for the API. The
   * two import tables diverge (fleet_imports.total_rows vs grab_imports.total_row),
   * so map both to `totalRows` and fill the progress fields the frontend reads.
   */
  private toBatch(platform: Platform, row: Record<string, unknown>) {
    const status = String(row.status);
    const totalRows = Number((platform === 'gojek' ? row.totalRows : row.totalRow) ?? 0);
    return {
      id: Number(row.id),
      filename: (row.filename as string | null) ?? null,
      periodMonth: Number(row.periodMonth),
      periodYear: Number(row.periodYear),
      totalRows,
      processed: status === 'done' ? totalRows : 0,
      percent: status === 'done' ? 100 : 0,
      status,
      error: null as string | null,
      importedBy: row.importedBy == null ? null : Number(row.importedBy),
      uploaderName: null as string | null, // resolved in list() (batch name lookup)
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    };
  }

  async upload(
    platform: Platform,
    file: UploadedFile,
    month: number,
    year: number,
    userId: number,
  ): Promise<{ importId: number }> {
    const kind = detectKind(file.originalname);
    if (!kind) {
      throw new BadRequestException('Unsupported file type — upload .csv or .xlsx');
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException('File too large (max 20 MB)');
    }

    const period = `${year}-${String(month).padStart(2, '0')}`;
    const fileKey = `import/fleet-monitoring${platform === 'grab' ? '-grab' : ''}/${period}/${nanoid(10)}-${file.originalname}`;
    await this.storage.save(fileKey, file.buffer);

    const table = this.importsTable(platform);
    const [row] = await this.database.db
      .insert(table)
      .values({
        filename: file.originalname,
        periodMonth: month,
        periodYear: year,
        importedBy: userId,
        status: 'pending',
      })
      .returning({ id: table.id });

    const jobData: ParseJobData = {
      platform,
      importId: row!.id,
      fileKey,
      filename: file.originalname,
      periodYear: year,
      periodMonth: month,
      kind,
    };
    await this.queue.add('parse', jobData, { attempts: 1 }); // failed imports roll back, never blind-retry

    return { importId: row!.id };
  }

  async list(platform: Platform) {
    const table = this.importsTable(platform);
    const rows = await this.database.db
      .select()
      .from(table)
      .orderBy(desc(table.createdAt))
      .limit(200);
    const batches = rows.map((r) => this.toBatch(platform, r as Record<string, unknown>));

    // Resolve "Diunggah Oleh" names in one lookup (legacy joined cms_users).
    const uploaderIds = [
      ...new Set(batches.map((b) => b.importedBy).filter((id): id is number => id != null)),
    ];
    if (uploaderIds.length > 0) {
      const people = await this.database.db
        .select({ id: users.id, fullName: users.fullName, email: users.email })
        .from(users)
        .where(inArray(users.id, uploaderIds));
      const nameById = new Map(people.map((p) => [p.id, p.fullName ?? p.email]));
      for (const b of batches) {
        b.uploaderName = b.importedBy == null ? null : (nameById.get(b.importedBy) ?? null);
      }
    }
    return batches;
  }

  async getById(platform: Platform, id: number) {
    const table = this.importsTable(platform);
    const [row] = await this.database.db.select().from(table).where(eq(table.id, id));
    if (!row) throw new NotFoundException(`Import ${id} not found`);
    return this.toBatch(platform, row);
  }

  async requestRollback(platform: Platform, id: number): Promise<{ queued: true }> {
    const row = await this.getById(platform, id);
    const jobData: RollbackJobData = {
      platform,
      importId: id,
      periodYear: row.periodYear,
      periodMonth: row.periodMonth,
    };
    await this.queue.add('rollback', jobData, { attempts: 1 });
    return { queued: true };
  }
}
