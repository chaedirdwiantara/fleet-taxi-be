import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { rentalCogsDefaults } from '../db/schema';
import { UpsertCogsDefaultDto } from './dto/upsert-cogs-default.dto';
import { slugifyCogsKey } from './rental-presenter';

export interface CogsDefaultDto {
  key: string;
  label: string;
  cogsPerDay: number;
}

/** Legacy jadwal-mobil-cogs "Setting COGS" defaults, seeded per partner on first read. */
const SEED_DEFAULTS: ReadonlyArray<{ key: string; label: string; cogsPerDay: number }> = [
  { key: 'denza', label: 'Denza', cogsPerDay: 897_167 },
  { key: 'ioniq', label: 'Ioniq', cogsPerDay: 602_500 },
  { key: 'air_ev', label: 'Air EV', cogsPerDay: 335_833 },
  { key: 'm6_cloud', label: 'M6 / Cloud', cogsPerDay: 388_000 },
  { key: 'seal', label: 'Seal', cogsPerDay: 585_833 },
  { key: 'binguo_neta', label: 'Binguo / Neta', cogsPerDay: 369_167 },
  { key: 'darion', label: 'Darion', cogsPerDay: 388_000 },
];

/** Per-partner default COGS/day per vehicle type, row-scoped to partnerId. */
@Injectable()
export class RentalCogsDefaultsService {
  constructor(private readonly database: DatabaseService) {}

  async list(partnerId: number): Promise<{ items: CogsDefaultDto[] }> {
    let rows = await this.rowsOf(partnerId);
    if (rows.length === 0) {
      // Lazy-seed the legacy defaults on the partner's first read. Concurrent
      // first calls are safe: the (partner_id, key) unique constraint makes the
      // second insert a no-op.
      await this.database.db
        .insert(rentalCogsDefaults)
        .values(
          SEED_DEFAULTS.map((d) => ({
            partnerId,
            vehicleTypeKey: d.key,
            vehicleTypeLabel: d.label,
            cogsPerDay: d.cogsPerDay,
          })),
        )
        .onConflictDoNothing();
      rows = await this.rowsOf(partnerId);
    }
    return { items: rows };
  }

  async upsert(partnerId: number, dto: UpsertCogsDefaultDto): Promise<CogsDefaultDto> {
    const label = dto.label.trim();

    if (dto.key) {
      const [row] = await this.database.db
        .update(rentalCogsDefaults)
        .set({ vehicleTypeLabel: label, cogsPerDay: dto.cogsPerDay, updatedAt: new Date() })
        .where(
          and(
            eq(rentalCogsDefaults.partnerId, partnerId),
            eq(rentalCogsDefaults.vehicleTypeKey, dto.key),
          ),
        )
        .returning();
      if (!row) throw new NotFoundException('Setting COGS tidak ditemukan');
      return { key: row.vehicleTypeKey, label: row.vehicleTypeLabel, cogsPerDay: row.cogsPerDay };
    }

    const key = await this.availableKey(partnerId, slugifyCogsKey(label) || 'lainnya');
    const [row] = await this.database.db
      .insert(rentalCogsDefaults)
      .values({
        partnerId,
        vehicleTypeKey: key,
        vehicleTypeLabel: label,
        cogsPerDay: dto.cogsPerDay,
      })
      .returning();
    return { key: row!.vehicleTypeKey, label: row!.vehicleTypeLabel, cogsPerDay: row!.cogsPerDay };
  }

  private async rowsOf(partnerId: number): Promise<CogsDefaultDto[]> {
    const rows = await this.database.db
      .select()
      .from(rentalCogsDefaults)
      .where(eq(rentalCogsDefaults.partnerId, partnerId))
      .orderBy(asc(rentalCogsDefaults.vehicleTypeLabel));
    return rows.map((r) => ({
      key: r.vehicleTypeKey,
      label: r.vehicleTypeLabel,
      cogsPerDay: r.cogsPerDay,
    }));
  }

  /** base, then base_2, base_3, … until the key is free for this partner. */
  private async availableKey(partnerId: number, base: string): Promise<string> {
    const taken = new Set(
      (
        await this.database.db
          .select({ key: rentalCogsDefaults.vehicleTypeKey })
          .from(rentalCogsDefaults)
          .where(eq(rentalCogsDefaults.partnerId, partnerId))
      ).map((r) => r.key),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}_${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
