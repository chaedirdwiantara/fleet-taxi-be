import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { MONITORING_MODES, parseMonitoringMode } from '../common/util/monitoring-mode';
import { DATE_RANGE_DOC, parseDateRange, parsePeriod, toStringArray } from '../common/util/period';
import { GrabGridService } from './grab-grid.service';
import { toGrabDriverDetail, toGrabGrid, toGrabSummary } from './grab-presenter';
import { buildGrabPeriodSummary } from './grab-range-summary';

@ApiTags('admin-fleet-grab')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/fleet/grab')
export class GrabController {
  constructor(private readonly gridService: GrabGridService) {}

  @Get('grid')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({
    summary: '31-day earnings pivot grid (composite key plate|city|driver, or one row per driver)',
  })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({ name: 'rentalPartner', required: false, isArray: true, type: String })
  @ApiQuery({ name: 'plate', required: false, type: String })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  async grid(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('rentalPartner') rentalPartner?: string | string[],
    @Query('plate') plate?: string,
    @Query('mode') mode?: string,
  ) {
    const period = parsePeriod(month, year);
    const result = await this.gridService.buildGrid(period.month, period.year, {
      rentalPartners: toStringArray(rentalPartner),
      plate,
      mode: parseMonitoringMode(mode),
    });
    return toGrabGrid(result);
  }

  @Get('summary')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({
    summary:
      'Dashboard summary — cards + daily/by-partner charts, plus the date-range ' +
      'block when ?dateFrom&dateTo is sent',
  })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({
    name: 'dateFrom',
    required: false,
    example: '2026-07-01',
    description: DATE_RANGE_DOC,
  })
  @ApiQuery({ name: 'dateTo', required: false, example: '2026-07-15' })
  @ApiQuery({ name: 'rentalPartner', required: false, isArray: true, type: String })
  async summary(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('rentalPartner') rentalPartner?: string | string[],
  ) {
    const period = parsePeriod(month, year);
    const rentalPartners = toStringArray(rentalPartner);
    const [summary, lastImportDate] = await Promise.all([
      buildGrabPeriodSummary(
        (m, y, dayWindow) => this.gridService.buildGrid(m, y, { rentalPartners, dayWindow }),
        period.month,
        period.year,
        parseDateRange(dateFrom, dateTo),
      ),
      this.gridService.lastImportDate(period.month, period.year),
    ]);
    return toGrabSummary(summary.base, lastImportDate, summary.range);
  }

  @Get('cell')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: 'Whole-month performance detail for one driver (eye modal)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({
    name: 'compositeKey',
    description: 'plate|city|driver, or drv:<NAME> when mode=driver',
  })
  @ApiQuery({ name: 'day', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  async cell(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('compositeKey') compositeKey: string,
    @Query('mode') mode?: string,
  ) {
    const period = parsePeriod(month, year);
    if (!compositeKey) throw new BadRequestException('compositeKey is required');
    const row = await this.gridService.findRow(
      period.month,
      period.year,
      compositeKey,
      undefined,
      parseMonitoringMode(mode),
    );
    if (!row) throw new NotFoundException('No data for that key');
    return toGrabDriverDetail(row);
  }
}
