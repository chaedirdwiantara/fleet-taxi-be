import { Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { partnerPlates } from '../db/schema';

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
   * All registered plate norms plus a norm → Type map from registration.
   * Two partners may register the same plate; the earliest registration's
   * Type wins so the map stays deterministic.
   */
  async unionScope(): Promise<{ norms: string[]; typeByNorm: Map<string, string> }> {
    const rows = await this.database.db
      .select({ norm: partnerPlates.plateNumberNorm, vehicleType: partnerPlates.vehicleType })
      .from(partnerPlates)
      .orderBy(asc(partnerPlates.id));

    const norms = new Set<string>();
    const typeByNorm = new Map<string, string>();
    for (const row of rows) {
      norms.add(row.norm);
      if (row.vehicleType && !typeByNorm.has(row.norm)) {
        typeByNorm.set(row.norm, row.vehicleType);
      }
    }
    return { norms: [...norms], typeByNorm };
  }
}
