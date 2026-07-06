import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, type SQL } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { fleetImportDetails } from '../db/schema';

export interface EditDriverInput {
  detailId?: number | null;
  plate?: string | null; // existing normalized plate (by-period edit)
  month?: number | null;
  year?: number | null;
  driverName?: string | null;
  vehiclePlate?: string | null;
  isManualPaymentSetoran?: number | null; // 0 | 1
  manualPaymentNote?: string | null;
}

function isManualPaymentType(type: string | null): boolean {
  return (type ?? '').toLowerCase().includes('manual payment');
}

/**
 * Editing of individual Gojek import DETAIL rows — the mutation half of the
 * legacy AdminFleetMonitoringController::postEditDriver (the target/grouping
 * upsert half lives in TargetsService). Kept separate from the read-only grid
 * builder so the pivot stays a pure function of the imported data.
 */
@Injectable()
export class DetailsService {
  constructor(private readonly database: DatabaseService) {}

  /** Prefill source for the Edit form when editing a single (manual) detail. */
  async getDetail(detailId: number, month?: number, year?: number) {
    const { db } = this.database;
    const [row] = await db
      .select()
      .from(fleetImportDetails)
      .where(this.detailWhere(detailId, month, year));
    if (!row) throw new NotFoundException(`Detail ${detailId} not found`);
    return {
      id: row.id,
      driverName: row.driverName,
      vehiclePlate: row.vehiclePlate,
      vehiclePlateNorm: row.vehiclePlateNorm,
      type: row.type,
      isManualPayment: isManualPaymentType(row.type),
      isManualPaymentSetoran: row.isManualPaymentSetoran,
      manualPaymentNote: row.manualPaymentNote,
      periodMonth: row.periodMonth,
      periodYear: row.periodYear,
    };
  }

  async editDriver(input: EditDriverInput): Promise<{ updated: number }> {
    const { db } = this.database;

    const plateProvided = input.vehiclePlate != null;
    const newPlate = plateProvided ? input.vehiclePlate!.trim() : undefined;
    const newPlateNorm = plateProvided ? normalizePlate(newPlate) : undefined;
    const newDriver = input.driverName != null ? input.driverName.trim().toUpperCase() : undefined;

    const patch: Record<string, unknown> = {};
    if (newDriver !== undefined) patch.driverName = newDriver;
    if (plateProvided) {
      patch.vehiclePlate = newPlate;
      patch.vehiclePlateNorm = newPlateNorm;
    }

    // ── single detail (Manual Payment tanpa plat, or a one-off fix) ──────────
    if (input.detailId != null) {
      const [existing] = await db
        .select()
        .from(fleetImportDetails)
        .where(this.detailWhere(input.detailId, input.month ?? undefined, input.year ?? undefined));
      if (!existing) throw new NotFoundException(`Detail ${input.detailId} not found`);

      // The Masuk/Tidak Masuk Setoran flag only applies to manual payments.
      if (isManualPaymentType(existing.type) && input.isManualPaymentSetoran != null) {
        const counted = input.isManualPaymentSetoran === 0 ? 0 : 1;
        patch.isManualPaymentSetoran = counted;
        if (counted === 1) {
          patch.manualPaymentNote = null; // Masuk Setoran → note not applicable
        } else if (input.manualPaymentNote !== undefined) {
          // Tidak Masuk: only overwrite when a note was actually sent, so a
          // partial update (flag only) never erases an existing reason.
          patch.manualPaymentNote = input.manualPaymentNote;
        }
      }

      if (Object.keys(patch).length === 0) return { updated: 0 };
      // Prune to the row's own partition using its real period (from `existing`),
      // so the UPDATE hits one partition even if the caller omitted month/year.
      const rows = await db
        .update(fleetImportDetails)
        .set(patch)
        .where(
          and(
            eq(fleetImportDetails.id, input.detailId),
            eq(fleetImportDetails.periodMonth, existing.periodMonth),
            eq(fleetImportDetails.periodYear, existing.periodYear),
          ),
        )
        .returning({ id: fleetImportDetails.id });
      return { updated: rows.length };
    }

    // ── whole plated vehicle across a period (rename / re-plate) ─────────────
    if (input.plate != null && input.month && input.year) {
      if (Object.keys(patch).length === 0) return { updated: 0 };
      const where = and(
        eq(fleetImportDetails.periodMonth, input.month),
        eq(fleetImportDetails.periodYear, input.year),
        eq(fleetImportDetails.vehiclePlateNorm, normalizePlate(input.plate)),
      );
      const rows = await db
        .update(fleetImportDetails)
        .set(patch)
        .where(where)
        .returning({ id: fleetImportDetails.id });
      return { updated: rows.length };
    }

    throw new BadRequestException('Provide detailId, or plate + month + year');
  }

  /** id + (optional) partition key so the update hits a single partition. */
  private detailWhere(detailId: number, month?: number, year?: number): SQL | undefined {
    if (month && year) {
      return and(
        eq(fleetImportDetails.id, detailId),
        eq(fleetImportDetails.periodMonth, month),
        eq(fleetImportDetails.periodYear, year),
      );
    }
    return eq(fleetImportDetails.id, detailId);
  }
}
