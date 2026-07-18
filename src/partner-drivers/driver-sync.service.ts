import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { drivers, partnerPlates } from '../db/schema';
import { fleetImportDetails, grabImportDetails } from '../db/schema/partitioned';
import { DriverSource } from './driver.constants';

/** One candidate roster row derived from the import data. */
interface SyncCandidate {
  nameNorm: string;
  name: string;
  source: DriverSource;
  plateNumber: string | null;
  plateNumberNorm: string | null;
  phone: string | null;
}

/**
 * Derives the partner's driver roster from the fleet-monitoring import data.
 * One DISTINCT-ON query per platform (latest row per normalized driver name
 * over the partner's registered plates) feeds a single batched
 * INSERT … ON CONFLICT DO NOTHING keyed on (partner_id, name_norm): new
 * drivers appear automatically, while rows that already exist — whether
 * synced earlier or manually completed since — are never modified, so manual
 * edits always win. Data completeness (documents, deposit, bank, …) is filled
 * in afterwards via the driver edit page.
 */
@Injectable()
export class DriverSyncService {
  constructor(private readonly database: DatabaseService) {}

  async syncFromFleet(partnerId: number): Promise<{ inserted: number; total: number }> {
    const plates = await this.database.db
      .select({ norm: partnerPlates.plateNumberNorm })
      .from(partnerPlates)
      .where(eq(partnerPlates.partnerId, partnerId));
    const norms = plates.map((p) => p.norm);
    if (norms.length === 0) return { inserted: 0, total: 0 };

    const [gojek, grab] = await Promise.all([
      this.gojekCandidates(norms),
      this.grabCandidates(norms),
    ]);

    // Merge by nameNorm — gojek wins as `source` when both platforms know the
    // driver, but grab still contributes the phone number it carries.
    const merged = new Map<string, SyncCandidate>();
    for (const c of gojek) merged.set(c.nameNorm, c);
    for (const c of grab) {
      const existing = merged.get(c.nameNorm);
      if (existing) {
        if (!existing.phone && c.phone) existing.phone = c.phone;
      } else {
        merged.set(c.nameNorm, c);
      }
    }
    if (merged.size === 0) return { inserted: 0, total: 0 };

    const inserted = await this.database.db
      .insert(drivers)
      .values(
        [...merged.values()].map((c) => ({
          partnerId,
          name: c.name,
          nameNorm: c.nameNorm,
          source: c.source,
          plateNumber: c.plateNumber,
          plateNumberNorm: c.plateNumberNorm,
          phone: c.phone,
          registrationStatus: 'approved', // legacy column; roster rows are live
          isActive: true,
        })),
      )
      .onConflictDoNothing({ target: [drivers.partnerId, drivers.nameNorm] })
      .returning({ id: drivers.id });

    if (inserted.length > 0) {
      // formatDriverCode's rule (DRV- + 6-digit zero-padded id) in one batch UPDATE.
      await this.database.db
        .update(drivers)
        .set({ driverCode: sql`'DRV-' || lpad(${drivers.id}::text, 6, '0')` })
        .where(
          inArray(
            drivers.id,
            inserted.map((r) => r.id),
          ),
        );
    }
    return { inserted: inserted.length, total: merged.size };
  }

  /** Latest distinct (driver, plate) per normalized name from the Gojek details. */
  private async gojekCandidates(norms: string[]): Promise<SyncCandidate[]> {
    const nameNorm = sql<string>`upper(regexp_replace(btrim(${fleetImportDetails.driverName}), '\\s+', ' ', 'g'))`;
    const rows = await this.database.db
      .selectDistinctOn([nameNorm], {
        nameNorm,
        name: sql<string>`btrim(${fleetImportDetails.driverName})`,
        plateNumber: fleetImportDetails.vehiclePlate,
        plateNumberNorm: fleetImportDetails.vehiclePlateNorm,
      })
      .from(fleetImportDetails)
      .where(
        and(
          inArray(fleetImportDetails.vehiclePlateNorm, norms),
          sql`${fleetImportDetails.driverName} is not null
            and btrim(${fleetImportDetails.driverName}) <> ''`,
        ),
      )
      .orderBy(nameNorm, sql`${fleetImportDetails.transactionDate} desc`);
    return rows
      .filter((r) => r.nameNorm !== '')
      .map((r) => ({ ...r, source: 'gojek' as const, phone: null }));
  }

  /** Latest distinct (driver, plate, phone) per normalized name from the Grab details. */
  private async grabCandidates(norms: string[]): Promise<SyncCandidate[]> {
    const nameNorm = sql<string>`upper(regexp_replace(btrim(${grabImportDetails.driverName}), '\\s+', ' ', 'g'))`;
    const rows = await this.database.db
      .selectDistinctOn([nameNorm], {
        nameNorm,
        name: sql<string>`btrim(${grabImportDetails.driverName})`,
        plateNumber: grabImportDetails.plateNumber,
        plateNumberNorm: grabImportDetails.plateNumberNorm,
        phone: grabImportDetails.driverPhoneNumber,
      })
      .from(grabImportDetails)
      .where(
        and(
          inArray(grabImportDetails.plateNumberNorm, norms),
          sql`${grabImportDetails.driverName} is not null
            and btrim(${grabImportDetails.driverName}) <> ''`,
        ),
      )
      .orderBy(nameNorm, sql`${grabImportDetails.date} desc`);
    return rows
      .filter((r) => r.nameNorm !== '')
      .map((r) => ({ ...r, source: 'grab' as const, phone: r.phone?.trim() || null }));
  }
}
