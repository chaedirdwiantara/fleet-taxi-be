import { and, eq, inArray } from 'drizzle-orm';
import type { DatabaseService } from '../db/database.service';
import { partnerPlates, partners } from '../db/schema';

/**
 * Live partner-account name per registered plate (Daftarkan Plat). The Gojek
 * and Grab grids overlay this over the free-text rental_partner stored on
 * fleet/grab target rows, so re-registering a plate under a different partner
 * account renames it everywhere without a manual data fix. When a plate is
 * registered under more than one active partner, the latest registration wins.
 */
export async function fetchRegisteredPartnerNames(
  database: DatabaseService,
  plates: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!plates.length) return map;

  const rows = await database.db
    .select({ plate: partnerPlates.plateNumberNorm, name: partners.name })
    .from(partnerPlates)
    .innerJoin(partners, eq(partnerPlates.partnerId, partners.id))
    .where(and(eq(partners.isActive, true), inArray(partnerPlates.plateNumberNorm, plates)))
    .orderBy(partnerPlates.createdAt);

  // ascending createdAt → the latest registration overwrites earlier ones
  for (const r of rows) map.set(r.plate, r.name);
  return map;
}
