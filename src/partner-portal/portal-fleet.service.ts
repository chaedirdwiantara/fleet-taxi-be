import { Injectable } from '@nestjs/common';
import {
  toCellBreakdown,
  toFleetGrid,
  toGojekSummary,
  type CellBreakdownDto,
  type FleetGridDto,
  type GojekSummaryDto,
} from '../fleet/fleet-presenter';
import { GojekGridService } from '../fleet/gojek-grid.service';
import { GrabGridService } from '../grab/grab-grid.service';
import {
  toGrabDriverDetail,
  toGrabGrid,
  type GrabDriverDetailDto,
  type GrabGridDto,
} from '../grab/grab-presenter';
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
  ) {}

  async gojekGrid(partnerId: number, month: number, year: number): Promise<FleetGridDto> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const result = await this.gojek.buildGrid(month, year, { scopePlates });
    return toFleetGrid(result);
  }

  async gojekCell(
    partnerId: number,
    month: number,
    year: number,
    plate: string,
    day: number,
  ): Promise<CellBreakdownDto | null> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const bucket = await this.gojek.getCell(month, year, plate, day, scopePlates);
    return bucket ? toCellBreakdown(bucket, plate, day) : null;
  }

  async gojekSummary(
    partnerId: number,
    month: number,
    year: number,
    day?: number,
  ): Promise<GojekSummaryDto> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const result = await this.gojek.buildGrid(month, year, { scopePlates });
    return toGojekSummary(result, day);
  }

  async grabGrid(partnerId: number, month: number, year: number): Promise<GrabGridDto> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const result = await this.grab.buildGrid(month, year, { scopePlates });
    return toGrabGrid(result);
  }

  async grabCell(
    partnerId: number,
    month: number,
    year: number,
    compositeKey: string,
  ): Promise<GrabDriverDetailDto | null> {
    const scopePlates = await this.plates.registeredNorms(partnerId);
    const row = await this.grab.findRow(month, year, compositeKey, scopePlates);
    return row ? toGrabDriverDetail(row) : null;
  }
}
