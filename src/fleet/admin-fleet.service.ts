import { Injectable } from '@nestjs/common';
import { RegisteredPlatesService } from '../partners/registered-plates.service';
import {
  toCellBreakdown,
  toFleetGrid,
  toGojekSummary,
  toPerformers,
  type CellBreakdownDto,
  type FleetGridDto,
  type GojekSummaryDto,
  type PerformersDto,
} from './fleet-presenter';
import { GojekGridService } from './gojek-grid.service';

/**
 * Admin fleet monitoring, scoped to the union of every partner's registered
 * plates — the admin table shows exactly the plates partners registered via
 * Daftarkan Plat, and summary/performers derive from that same scoped grid so
 * they never count an unregistered plate. Mirrors PortalFleetService, which
 * does the per-partner version of this. No registered plates anywhere ⇒ empty
 * grid / Rp 0 (not an error).
 */
@Injectable()
export class AdminFleetService {
  constructor(
    private readonly registeredPlates: RegisteredPlatesService,
    private readonly gojek: GojekGridService,
  ) {}

  async gojekGrid(
    month: number,
    year: number,
    filters: { rentalPartners?: string[]; plate?: string } = {},
  ): Promise<FleetGridDto> {
    const { norms, typeByNorm, partnerNameByNorm } = await this.registeredPlates.unionScope();
    const result = await this.gojek.buildGrid(month, year, {
      ...filters,
      scopePlates: norms,
      partnerNameByNorm,
    });
    const dto = toFleetGrid(result);
    // Surface the Type entered in Daftarkan Plat when the grid has none (no
    // admin fleet target set it) — same sync the partner portal does.
    for (const row of dto.rows) {
      if (!row.vehicleType) {
        const type = typeByNorm.get(row.plateNorm);
        if (type) row.vehicleType = type;
      }
    }
    return dto;
  }

  async gojekCell(
    month: number,
    year: number,
    plate: string,
    day: number,
  ): Promise<CellBreakdownDto | null> {
    const { norms } = await this.registeredPlates.unionScope();
    const bucket = await this.gojek.getCell(month, year, plate, day, norms);
    return bucket ? toCellBreakdown(bucket, plate, day) : null;
  }

  async gojekSummary(
    month: number,
    year: number,
    day?: number,
    rentalPartners?: string[],
  ): Promise<GojekSummaryDto> {
    const { norms, partnerNameByNorm } = await this.registeredPlates.unionScope();
    const result = await this.gojek.buildGrid(month, year, {
      scopePlates: norms,
      partnerNameByNorm,
      rentalPartners,
    });
    return toGojekSummary(result, day);
  }

  async gojekPerformers(month: number, year: number): Promise<PerformersDto> {
    const { norms } = await this.registeredPlates.unionScope();
    const grid = await this.gojek.buildGrid(month, year, { scopePlates: norms });
    return toPerformers({
      topPerformers: grid.topPerformers,
      bottomPerformers: grid.bottomPerformers,
    });
  }
}
