import { ForbiddenException, Injectable } from '@nestjs/common';
import type { MonitoringMode } from '../common/util/monitoring-mode';
import type { DateRange } from '../common/util/period';
import { normalizePlate } from '../common/util/plate';
import { ExceptionsService, type CreateExceptionInput } from '../fleet/exceptions.service';
import {
  toCellBreakdown,
  toFleetGrid,
  toGojekSummary,
  type CellBreakdownDto,
  type FleetGridDto,
  type GojekSummaryDto,
} from '../fleet/fleet-presenter';
import { GojekGridService } from '../fleet/gojek-grid.service';
import { buildPeriodSummary } from '../fleet/range-summary';
import { GrabGridService } from '../grab/grab-grid.service';
import {
  toGrabDriverDetail,
  toGrabGrid,
  toGrabSummary,
  type GrabDriverDetailDto,
  type GrabGridDto,
  type GrabSummaryDto,
} from '../grab/grab-presenter';
import { buildGrabPeriodSummary } from '../grab/grab-range-summary';
import { PortalPlatesService } from './portal-plates.service';

/**
 * Read-only fleet monitoring for the partner portal. Every query is scoped to
 * the partner's registered plates (partner_plates) resolved from the SESSION
 * partnerId — the client never supplies the plate allowlist. A partner with no
 * registered plates gets an empty grid / Rp 0 summary.
 */
@Injectable()
export class PortalFleetService {
  constructor(
    private readonly plates: PortalPlatesService,
    private readonly gojek: GojekGridService,
    private readonly grab: GrabGridService,
    private readonly exceptions: ExceptionsService,
  ) {}

  async gojekGrid(
    partnerId: number,
    month: number,
    year: number,
    mode: MonitoringMode = 'plate',
  ): Promise<FleetGridDto> {
    const [scopePlates, typeMap] = await Promise.all([
      this.plates.registeredNorms(partnerId),
      this.plates.typeByNorm(partnerId),
    ]);
    const result = await this.gojek.buildGrid(month, year, { scopePlates, mode });
    const dto = toFleetGrid(result);
    // Surface the Type the partner entered in Daftarkan Plat when the grid has
    // none (no admin fleet target set it) — matches the registration screen.
    for (const row of dto.rows) {
      if (!row.vehicleType) {
        const type = typeMap.get(row.plateNorm);
        if (type) row.vehicleType = type;
      }
    }
    return dto;
  }

  async gojekCell(
    partnerId: number,
    month: number,
    year: number,
    rowKey: string,
    day: number,
    mode: MonitoringMode = 'plate',
  ): Promise<CellBreakdownDto | null> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const bucket = await this.gojek.getCell(month, year, rowKey, day, scopePlates, mode);
    return bucket ? toCellBreakdown(bucket, rowKey, day) : null;
  }

  async gojekSummary(
    partnerId: number,
    month: number,
    year: number,
    range?: DateRange,
  ): Promise<GojekSummaryDto> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const summary = await buildPeriodSummary(
      (m, y, dayWindow) => this.gojek.buildGrid(m, y, { scopePlates, dayWindow }),
      month,
      year,
      range,
    );
    return toGojekSummary(summary.base, summary.range);
  }

  // ── exceptions ("Kelola Jadwal"), scoped to the partner's own plates ───────
  // fleet_exceptions has no owner column: ownership is enforced by intersecting
  // the (normalized) plate with the partner's registered allowlist on every op.

  /** Plate ∈ allowlist or throw — the partner can only touch its own plates. */
  private async requireOwnPlate(partnerId: number, plate: string): Promise<string> {
    const norm = normalizePlate(plate);
    const scopePlates = await this.plates.registeredNorms(partnerId);
    if (!norm || !scopePlates.includes(norm)) {
      throw new ForbiddenException('Plat tidak terdaftar pada akun partner ini');
    }
    return norm;
  }

  async listExceptions(partnerId: number, month: number, year: number) {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const rows = await this.exceptions.list(month, year);
    // vehicle_plate is stored normalized (ExceptionsService.create), so a plain
    // set intersection is the scoping.
    const allowed = new Set(scopePlates);
    return rows.filter((r) => allowed.has(normalizePlate(r.vehiclePlate)));
  }

  async createException(partnerId: number, input: CreateExceptionInput) {
    await this.requireOwnPlate(partnerId, input.vehiclePlate);
    return this.exceptions.create(input);
  }

  async removeException(partnerId: number, id: number): Promise<{ deleted: true }> {
    const row = await this.exceptions.getById(id);
    await this.requireOwnPlate(partnerId, row.vehiclePlate);
    return this.exceptions.remove(id);
  }

  async grabGrid(
    partnerId: number,
    month: number,
    year: number,
    mode: MonitoringMode = 'plate',
  ): Promise<GrabGridDto> {
    const [scopePlates, typeMap] = await Promise.all([
      this.plates.registeredNorms(partnerId),
      this.plates.typeByNorm(partnerId),
    ]);
    const result = await this.grab.buildGrid(month, year, { scopePlates, mode });
    const dto = toGrabGrid(result);
    for (const row of dto.rows) {
      if (!row.vehicleType || row.vehicleType === '-') {
        const type = typeMap.get(row.plateNumber);
        if (type) row.vehicleType = type;
      }
    }
    return dto;
  }

  /**
   * Own Grab dashboard aggregates — the partner twin of the admin Grab summary,
   * so both surfaces read the same cards from the same presenter instead of the
   * portal re-deriving them from the grid's own totals.
   */
  async grabSummary(
    partnerId: number,
    month: number,
    year: number,
    range?: DateRange,
  ): Promise<GrabSummaryDto> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const [summary, lastImportDate] = await Promise.all([
      buildGrabPeriodSummary(
        (m, y, dayWindow) => this.grab.buildGrid(m, y, { scopePlates, dayWindow }),
        month,
        year,
        range,
      ),
      this.grab.lastImportDate(month, year),
    ]);
    return toGrabSummary(summary.base, lastImportDate, summary.range);
  }

  async grabCell(
    partnerId: number,
    month: number,
    year: number,
    rowKey: string,
    mode: MonitoringMode = 'plate',
  ): Promise<GrabDriverDetailDto | null> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const row = await this.grab.findRow(month, year, rowKey, scopePlates, mode);
    return row ? toGrabDriverDetail(row) : null;
  }
}
