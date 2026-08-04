import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { adminPlates, partnerPlates, partners } from '../db/schema';

/**
 * The ADMIN fleet scope: every partner's registered plates (partner_plates
 * across ALL partners) PLUS the admin console's own registry (admin_plates,
 * "Plate Registration"). A plate nobody registered still never appears — but the
 * admin can now register one itself, which is the only way a vehicle no partner
 * claimed becomes visible in the admin monitoring.
 *
 * The widening is one-way on purpose: per-partner scoping stays in
 * PortalPlatesService and reads partner_plates alone, so a partner never sees an
 * admin registration unless it registers the same plate in its own portal.
 */
@Injectable()
export class RegisteredPlatesService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * All in-scope plate norms plus norm → Type and norm → partner-name maps.
   *
   * Two partners may register the same plate (e.g. a fleet handed over to a new
   * partner while the old account lingers); the LATEST registration wins in both
   * maps, so re-registering a plate transfers its Rental Partner label
   * immediately and deterministically. An admin registration then overrides both
   * on top of that — they are the admin's own entries, typed in the admin
   * console. A plate whose admin registration names no partner keeps whatever
   * the partner registration said, and failing that the legacy
   * fleet_targets.rental_partner text.
   */
  async unionScope(): Promise<{
    norms: string[];
    typeByNorm: Map<string, string>;
    partnerNameByNorm: Map<string, string>;
  }> {
    const [partnerRows, adminRows] = await Promise.all([
      this.database.db
        .select({
          norm: partnerPlates.plateNumberNorm,
          vehicleType: partnerPlates.vehicleType,
          partnerName: partners.name,
        })
        .from(partnerPlates)
        .innerJoin(partners, eq(partners.id, partnerPlates.partnerId))
        .orderBy(asc(partnerPlates.id)),
      this.database.db
        .select({
          norm: adminPlates.plateNumberNorm,
          vehicleType: adminPlates.vehicleType,
          partnerName: adminPlates.partnerName,
        })
        .from(adminPlates)
        .orderBy(asc(adminPlates.id)),
    ]);

    const norms = new Set<string>();
    const typeByNorm = new Map<string, string>();
    const partnerNameByNorm = new Map<string, string>();
    for (const row of partnerRows) {
      norms.add(row.norm);
      // ascending id → later registrations overwrite earlier ones
      if (row.vehicleType) typeByNorm.set(row.norm, row.vehicleType);
      if (row.partnerName) partnerNameByNorm.set(row.norm, row.partnerName);
    }
    for (const row of adminRows) {
      norms.add(row.norm);
      if (row.vehicleType) typeByNorm.set(row.norm, row.vehicleType);
      if (row.partnerName) partnerNameByNorm.set(row.norm, row.partnerName);
    }
    return { norms: [...norms], typeByNorm, partnerNameByNorm };
  }
}
