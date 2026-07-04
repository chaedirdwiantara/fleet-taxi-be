import { sql } from 'drizzle-orm';
import type { DatabaseService } from './database.service';

export type PartitionedDetailTable = 'fleet_import_details' | 'grab_import_details';

const TABLES: ReadonlySet<PartitionedDetailTable> = new Set([
  'fleet_import_details',
  'grab_import_details',
]);

export function detailPartitionName(
  table: PartitionedDetailTable,
  year: number,
  month: number,
): string {
  return `${table}_y${year}m${String(month).padStart(2, '0')}`;
}

/**
 * Idempotently creates the child partition for a (year, month) period.
 * Called by the import worker before bulk-inserting a period's rows.
 */
export async function ensureDetailPartition(
  dbService: DatabaseService,
  table: PartitionedDetailTable,
  year: number,
  month: number,
): Promise<string> {
  if (!TABLES.has(table)) throw new Error(`Not a partitioned detail table: ${table}`);
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error(`Invalid year: ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12)
    throw new Error(`Invalid month: ${month}`);

  const name = detailPartitionName(table, year, month);
  const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];

  // Identifiers are validated above; RANGE bounds are integers.
  await dbService.db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table}" ` +
        `FOR VALUES FROM (${year}, ${month}) TO (${nextYear}, ${nextMonth})`,
    ),
  );
  return name;
}

/** Fast-path rollback helper: drop a period's whole child partition. */
export async function dropDetailPartition(
  dbService: DatabaseService,
  table: PartitionedDetailTable,
  year: number,
  month: number,
): Promise<void> {
  if (!TABLES.has(table)) throw new Error(`Not a partitioned detail table: ${table}`);
  const name = detailPartitionName(table, year, month);
  await dbService.db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
}
