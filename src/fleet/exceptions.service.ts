import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { fleetExceptions } from '../db/schema';

export interface CreateExceptionInput {
  vehiclePlate: string;
  exceptionDate: string; // YYYY-MM-DD
  keterangan?: string;
  isBebasSetoran?: boolean;
}

@Injectable()
export class ExceptionsService {
  constructor(private readonly database: DatabaseService) {}

  async list(month: number, year: number) {
    return this.database.db
      .select()
      .from(fleetExceptions)
      .where(
        and(
          sql`EXTRACT(MONTH FROM ${fleetExceptions.exceptionDate}) = ${month}`,
          sql`EXTRACT(YEAR FROM ${fleetExceptions.exceptionDate}) = ${year}`,
        ),
      );
  }

  async create(input: CreateExceptionInput) {
    const [row] = await this.database.db
      .insert(fleetExceptions)
      .values({
        vehiclePlate: normalizePlate(input.vehiclePlate),
        exceptionDate: input.exceptionDate,
        keterangan: input.keterangan,
        isBebasSetoran: input.isBebasSetoran ?? false,
      })
      .returning();
    return row;
  }

  async getById(id: number) {
    const [row] = await this.database.db
      .select()
      .from(fleetExceptions)
      .where(eq(fleetExceptions.id, id));
    if (!row) throw new NotFoundException(`Exception ${id} not found`);
    return row;
  }

  async remove(id: number): Promise<{ deleted: true }> {
    const rows = await this.database.db
      .delete(fleetExceptions)
      .where(eq(fleetExceptions.id, id))
      .returning({ id: fleetExceptions.id });
    if (!rows.length) throw new NotFoundException(`Exception ${id} not found`);
    return { deleted: true };
  }
}
