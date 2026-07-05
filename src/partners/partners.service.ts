import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { partners } from '../db/schema';

export interface PartnerRow {
  id: number;
  code: string;
  name: string;
  type: string | null;
  isActive: boolean;
  createdAt: Date;
}

@Injectable()
export class PartnersService {
  constructor(private readonly database: DatabaseService) {}

  /** Creates a partner entity. Throws 409 CONFLICT on a duplicate code. */
  async createPartner(input: {
    code: string;
    name: string;
    type?: string | null;
  }): Promise<PartnerRow> {
    const db = this.database.db;
    const code = input.code.trim().toUpperCase();

    const existing = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.code, code));
    if (existing.length > 0) {
      throw new ConflictException('Partner code already in use');
    }

    const [row] = await db
      .insert(partners)
      .values({ code, name: input.name.trim(), type: input.type?.trim() || null })
      .returning();
    return this.toRow(row!);
  }

  /** Lists all partners (for the "pick existing partner" dropdown), by code. */
  async listPartners(): Promise<PartnerRow[]> {
    const rows = await this.database.db.select().from(partners).orderBy(asc(partners.code));
    return rows.map((r) => this.toRow(r));
  }

  /** Returns a partner or throws 404. */
  async requirePartner(id: number): Promise<PartnerRow> {
    const [row] = await this.database.db
      .select()
      .from(partners)
      .where(eq(partners.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Partner not found');
    return this.toRow(row);
  }

  private toRow(row: typeof partners.$inferSelect): PartnerRow {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  }
}
