import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { partnerPlates, partners } from '../db/schema';

/**
 * Union of every partner's registered plates (partner_plates across ALL
 * partners). This is the server-derived allowlist that scopes the ADMIN fleet
 * monitoring: the admin table mirrors exactly what partners registered via
 * Daftarkan Plat, so a plate no partner registered never appears. Per-partner
 * scoping (the portal) stays in PortalPlatesService.
 */
@Injectable()
export class RegisteredPlatesService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * All registered plate norms plus norm → Type and norm → partner-name maps
   * from registration. Two partners may register the same plate (e.g. a fleet
   * handed over to a new partner while the old account lingers); the LATEST
   * registration wins in both maps, so re-registering a plate transfers its
   * Rental Partner label immediately and deterministically.
   */
  async unionScope(): Promise<{
    norms: string[];
    typeByNorm: Map<string, string>;
    partnerNameByNorm: Map<string, string>;
  }> {
    const rows = await this.database.db
      .select({
        norm: partnerPlates.plateNumberNorm,
        vehicleType: partnerPlates.vehicleType,
        partnerName: partners.name,
      })
      .from(partnerPlates)
      .innerJoin(partners, eq(partners.id, partnerPlates.partnerId))
      .orderBy(asc(partnerPlates.id));

    const norms = new Set<string>();
    const typeByNorm = new Map<string, string>();
    const partnerNameByNorm = new Map<string, string>();
    for (const row of rows) {
      norms.add(row.norm);
      // ascending id → later registrations overwrite earlier ones
      if (row.vehicleType) typeByNorm.set(row.norm, row.vehicleType);
      if (row.partnerName) partnerNameByNorm.set(row.norm, row.partnerName);
    }
    return { norms: [...norms], typeByNorm, partnerNameByNorm };
  }
}
