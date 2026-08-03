import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { adminPlates } from '../db/schema';
import { fetchRegisteredPartnerNames } from '../fleet/registered-partner-names';
import { AdminPlateDto } from './dto/admin-plate.dto';

export interface AdminPlate {
  id: number;
  plateNumber: string;
  plateNumberNorm: string;
  vehicleType: string | null;
  /** Free-text partner label the admin typed on this registration. */
  partnerName: string | null;
  /**
   * Active partner that registered the SAME plate in its own portal, or null
   * when nobody claimed it. Never stored — resolved from partner_plates on
   * every read, so it stays correct when a plate changes hands. The UI shows it
   * only where partnerName is empty.
   */
  registeredPartnerName: string | null;
}

/**
 * CRUD for the admin console's own registered plates ("Plate Registration").
 * One global registry (no partner scoping), super_admin-gated at the controller.
 * Registering here widens the admin fleet scope — see
 * RegisteredPlatesService.unionScope — without ever touching what a partner sees.
 */
@Injectable()
export class AdminPlatesService {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<AdminPlate[]> {
    const rows = await this.database.db
      .select()
      .from(adminPlates)
      .orderBy(asc(adminPlates.plateNumberNorm));

    // Same helper (and therefore the same latest-registration-wins semantics)
    // the Gojek/Grab grids use for their Rental Partner label.
    const partnerNames = await fetchRegisteredPartnerNames(
      this.database,
      rows.map((r) => r.plateNumberNorm),
    );
    return rows.map((r) => this.present(r, partnerNames.get(r.plateNumberNorm) ?? null));
  }

  /** Normalized plates + norm → Type, for the admin fleet scope. */
  async registered(): Promise<{ norms: string[]; typeByNorm: Map<string, string> }> {
    const rows = await this.database.db
      .select({ norm: adminPlates.plateNumberNorm, vehicleType: adminPlates.vehicleType })
      .from(adminPlates);

    const typeByNorm = new Map<string, string>();
    for (const row of rows) if (row.vehicleType) typeByNorm.set(row.norm, row.vehicleType);
    return { norms: rows.map((r) => r.norm), typeByNorm };
  }

  async create(dto: AdminPlateDto): Promise<AdminPlate> {
    const norm = this.requireNorm(dto);

    const [row] = await this.database.db
      .insert(adminPlates)
      .values({
        plateNumber: dto.plateNumber.trim(),
        plateNumberNorm: norm,
        vehicleType: dto.vehicleType?.trim() || null,
        partnerName: dto.partnerName?.trim() || null,
      })
      .onConflictDoNothing({ target: adminPlates.plateNumberNorm })
      .returning();

    if (!row) throw new ConflictException('Plat sudah terdaftar');
    return this.present(row, await this.registeredPartnerNameOf(norm));
  }

  async update(id: number, dto: AdminPlateDto): Promise<AdminPlate> {
    const norm = this.requireNorm(dto);

    const [existing] = await this.database.db
      .select()
      .from(adminPlates)
      .where(eq(adminPlates.id, id));
    if (!existing) throw new NotFoundException('Plat tidak ditemukan');

    // Re-plating onto a norm another row already holds collides.
    if (norm !== existing.plateNumberNorm) {
      const [dupe] = await this.database.db
        .select({ id: adminPlates.id })
        .from(adminPlates)
        .where(eq(adminPlates.plateNumberNorm, norm));
      if (dupe) throw new ConflictException('Plat sudah terdaftar');
    }

    const [row] = await this.database.db
      .update(adminPlates)
      .set({
        plateNumber: dto.plateNumber.trim(),
        plateNumberNorm: norm,
        vehicleType: dto.vehicleType?.trim() || null,
        partnerName: dto.partnerName?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(adminPlates.id, id))
      .returning();

    return this.present(row!, await this.registeredPartnerNameOf(norm));
  }

  async remove(id: number): Promise<{ deleted: true }> {
    const [row] = await this.database.db
      .delete(adminPlates)
      .where(eq(adminPlates.id, id))
      .returning({ id: adminPlates.id });
    if (!row) throw new NotFoundException('Plat tidak ditemukan');
    return { deleted: true };
  }

  private requireNorm(dto: AdminPlateDto): string {
    const norm = normalizePlate(dto.plateNumber);
    if (!norm) throw new BadRequestException('Nomor plat tidak valid');
    return norm;
  }

  /** Partner that registered this norm in its own portal, if any. */
  private async registeredPartnerNameOf(norm: string): Promise<string | null> {
    const names = await fetchRegisteredPartnerNames(this.database, [norm]);
    return names.get(norm) ?? null;
  }

  private present(
    row: {
      id: number;
      plateNumber: string;
      plateNumberNorm: string;
      vehicleType: string | null;
      partnerName: string | null;
    },
    registeredPartnerName: string | null,
  ): AdminPlate {
    return {
      id: row.id,
      plateNumber: row.plateNumber,
      plateNumberNorm: row.plateNumberNorm,
      vehicleType: row.vehicleType,
      partnerName: row.partnerName,
      registeredPartnerName,
    };
  }
}
