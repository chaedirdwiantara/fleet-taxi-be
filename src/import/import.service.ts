import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DatabaseService } from '../db/database.service';
import { fleetImports, grabImports } from '../db/schema';
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
    return this.database.db.select().from(table).orderBy(desc(table.createdAt)).limit(200);
  }

  async getById(platform: Platform, id: number) {
    const table = this.importsTable(platform);
    const [row] = await this.database.db.select().from(table).where(eq(table.id, id));
    if (!row) throw new NotFoundException(`Import ${id} not found`);
    return row;
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
