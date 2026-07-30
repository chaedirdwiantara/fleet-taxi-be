import { Injectable } from '@nestjs/common';
import type { MonitoringMode } from '../common/util/monitoring-mode';
import type { DateRange } from '../common/util/period';
import { RegisteredPlatesService } from '../partners/registered-plates.service';
import {
  toCellBreakdown,
  toFleetGrid,
  toGojekSummary,
  type CellBreakdownDto,
  type FleetGridDto,
  type GojekSummaryDto,
} from './fleet-presenter';
import { GojekGridService } from './gojek-grid.service';
import { buildPeriodSummary } from './range-summary';

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
    filters: { rentalPartners?: string[]; plate?: string; mode?: MonitoringMode } = {},
  ): Promise<FleetGridDto> {
    const { norms, typeByNorm, partnerNameByNorm } = await this.registeredPlates.unionScope();
    const result = await this.gojek.buildGrid(month, year, {
      ...filters,
      scopePlates: norms,
      partnerNameByNorm,
      // the "Data Mentah Tanpa Plat" processing queue is an admin concern —
      // unplated rows can never belong to a partner's scope
      includeRawManual: true,
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
    rowKey: string,
    day: number,
    mode: MonitoringMode = 'plate',
  ): Promise<CellBreakdownDto | null> {
    const { norms } = await this.registeredPlates.unionScope();
    const bucket = await this.gojek.getCell(month, year, rowKey, day, norms, mode);
    return bucket ? toCellBreakdown(bucket, rowKey, day) : null;
  }

  async gojekSummary(
    month: number,
    year: number,
    range?: DateRange,
    rentalPartners?: string[],
  ): Promise<GojekSummaryDto> {
    const { norms, partnerNameByNorm } = await this.registeredPlates.unionScope();
    const summary = await buildPeriodSummary(
      (m, y, dayWindow) =>
        this.gojek.buildGrid(m, y, {
          scopePlates: norms,
          partnerNameByNorm,
          rentalPartners,
          dayWindow,
        }),
      month,
      year,
      range,
    );
    return toGojekSummary(summary.base, summary.range);
  }
}
