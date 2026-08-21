import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { drivers, partnerPlates } from '../db/schema';
import { fleetImportDetails, grabImportDetails } from '../db/schema/partitioned';
import { DriverSource } from './driver.constants';

/** Newest transaction date per platform (YYYY-MM-DD); null = unknown there. */
export interface LastSeen {
  gojekLastSeen: string | null;
  grabLastSeen: string | null;
}

/** One candidate roster row derived from the import data. */
interface SyncCandidate extends LastSeen {
  nameNorm: string;
  name: string;
  source: DriverSource;
  plateNumber: string | null;
  plateNumberNorm: string | null;
  phone: string | null;
}

/** Newest transaction date of each platform's whole dataset. */
export interface ImportHorizon {
  gojek: string | null;
  grab: string | null;
}

/**
 * Auto-exit decision ("Driver Keluar"): a driver has left once EVERY platform
 * that knows them has moved past their last transaction — i.e. their newest row
 * is older than that platform's newest row anywhere. The horizon is deliberately
 * global (not partner-scoped) for the same reason the Gojek grid uses it: it is
 * the data cut-off, so a partner whose entire fleet stopped still sees the exits.
 *
 * The rule is a pure function of the current import data, so it needs no
 * bookkeeping: a driver who shows up again in a later import automatically stops
 * matching and is cleared from the resign list on the next sync.
 *
 * Returns the exit date (the driver's own last-seen day, what the grid renders
 * as "Keluar · <tanggal>") or null while they are still current.
 */
export function exitDateOf(candidate: LastSeen, horizon: ImportHorizon): string | null {
  const seen = [
    { last: candidate.gojekLastSeen, edge: horizon.gojek },
    { last: candidate.grabLastSeen, edge: horizon.grab },
  ].filter((p): p is { last: string; edge: string | null } => p.last !== null);
  if (seen.length === 0) return null; // manual row — never auto-exited
  // Still current on any platform (or that platform has no horizon to compare
  // against) ⇒ not exited.
  if (seen.some((p) => p.edge === null || p.last >= p.edge)) return null;
  return seen.reduce((max, p) => (p.last > max ? p.last : max), seen[0]!.last);
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
 *
 * The same pass refreshes the derived `exited_at` column (see exitDateOf), the
 * automatic half of the Driver Resign list.
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
    // driver, but grab still contributes the phone number and its own last-seen
    // date (a driver still active on Grab has not left the fleet).
    const merged = new Map<string, SyncCandidate>();
    for (const c of gojek) merged.set(c.nameNorm, c);
    for (const c of grab) {
      const existing = merged.get(c.nameNorm);
      if (existing) {
        if (!existing.phone && c.phone) existing.phone = c.phone;
        existing.grabLastSeen = c.grabLastSeen;
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

    const candidates = [...merged.values()];
    await this.refreshExits(partnerId, candidates, await this.importHorizon(candidates));
    return { inserted: inserted.length, total: merged.size };
  }

  /**
   * Writes the derived exit state back onto the roster: stamps `exited_at` for
   * drivers that have left and clears it for those still current. Only rows
   * whose value actually changes are touched, so the common "nothing moved"
   * sync — this runs on every roster GET — writes nothing at all. `updated_at`
   * is deliberately left alone: this is derived data, not a partner edit.
   */
  private async refreshExits(
    partnerId: number,
    candidates: SyncCandidate[],
    horizon: ImportHorizon,
  ): Promise<void> {
    const current: string[] = [];
    const byExitDate = new Map<string, string[]>();
    for (const c of candidates) {
      const exitDate = exitDateOf(c, horizon);
      if (exitDate === null) {
        current.push(c.nameNorm);
        continue;
      }
      const group = byExitDate.get(exitDate);
      if (group) group.push(c.nameNorm);
      else byExitDate.set(exitDate, [c.nameNorm]);
    }

    // Reappeared (or never gone) → drop off the resign list automatically.
    if (current.length > 0) {
      await this.database.db
        .update(drivers)
        .set({ exitedAt: null })
        .where(
          and(
            eq(drivers.partnerId, partnerId),
            isNotNull(drivers.exitedAt),
            inArray(drivers.nameNorm, current),
          ),
        );
    }

    // One statement per distinct exit day — in practice a handful of import dates.
    for (const [exitDate, names] of byExitDate) {
      await this.database.db
        .update(drivers)
        .set({ exitedAt: exitDate })
        .where(
          and(
            eq(drivers.partnerId, partnerId),
            inArray(drivers.nameNorm, names),
            or(isNull(drivers.exitedAt), ne(drivers.exitedAt, exitDate)),
          ),
        );
    }
  }

  /**
   * Newest transaction date per platform across ALL imported data. Both columns
   * are indexed on the partitioned parents, so this is a per-partition index
   * scan rather than a table scan — but a platform nobody in this roster is
   * known on can't change any verdict, so it is not queried at all (the common
   * gojek-only fleet never touches the Grab partitions).
   */
  private async importHorizon(candidates: LastSeen[]): Promise<ImportHorizon> {
    const needGojek = candidates.some((c) => c.gojekLastSeen !== null);
    const needGrab = candidates.some((c) => c.grabLastSeen !== null);
    const [gojek, grab] = await Promise.all([
      needGojek
        ? this.database.db
            .select({ last: sql<string | null>`max(${fleetImportDetails.transactionDate})::text` })
            .from(fleetImportDetails)
        : Promise.resolve([]),
      needGrab
        ? this.database.db
            .select({ last: sql<string | null>`max(${grabImportDetails.date})::text` })
            .from(grabImportDetails)
        : Promise.resolve([]),
    ]);
    return { gojek: gojek[0]?.last ?? null, grab: grab[0]?.last ?? null };
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
        lastSeen: sql<string>`${fleetImportDetails.transactionDate}::text`,
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
      .map(({ lastSeen, ...r }) => ({
        ...r,
        source: 'gojek' as const,
        phone: null,
        gojekLastSeen: lastSeen,
        grabLastSeen: null,
      }));
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
        lastSeen: sql<string>`${grabImportDetails.date}::text`,
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
      .map(({ lastSeen, ...r }) => ({
        ...r,
        source: 'grab' as const,
        phone: r.phone?.trim() || null,
        gojekLastSeen: null,
        grabLastSeen: lastSeen,
      }));
  }
}
