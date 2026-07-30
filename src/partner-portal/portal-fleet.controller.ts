import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { MONITORING_MODES, parseMonitoringMode } from '../common/util/monitoring-mode';
import { parsePeriod } from '../common/util/period';
import { CreateExceptionDto } from '../fleet/dto/fleet.dto';
import { PortalAllFleetService } from './portal-all-fleet.service';
import { PortalFleetService } from './portal-fleet.service';
import { requirePartner } from './portal.util';

/** Day-of-month query param, validated once for every cell endpoint. */
function parseDay(raw: string): number {
  const day = Number(raw);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new BadRequestException('day must be an integer 1..31');
  }
  return day;
}

/**
 * Partner-scoped fleet monitoring (All Fleet + Gojek + Grab). Mirrors the admin
 * fleet endpoints' response shapes so the frontend reuses the same components,
 * but the data is filtered to the partner's own registered plates. Read-only
 * except the exception schedule (Kelola Jadwal), which partners manage for
 * their own plates.
 *
 * Every grid endpoint takes `mode` (`plate` | `driver`): the same rows grouped by
 * vehicle or by person. Totals are identical either way — see
 * common/util/monitoring-mode.ts.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/fleet')
export class PortalFleetController {
  constructor(
    private readonly fleet: PortalFleetService,
    private readonly allFleet: PortalAllFleetService,
  ) {}

  @Get('all/grid')
  @ApiOperation({
    summary: 'Own combined fleet income matrix — Gojek + Grab + Rental per subject per day',
  })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  allFleetGrid(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('mode') mode?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    return this.allFleet.grid(partnerId, period.month, period.year, parseMonitoringMode(mode));
  }

  @Get('all/cell')
  @ApiOperation({ summary: 'Transactions behind one All Fleet cell (subject + day, per source)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({
    name: 'key',
    description: 'Row key: normalized plate, drv:<NAME>, or "residual" for the unattributed row',
  })
  @ApiQuery({ name: 'day', type: Number, example: 15 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  async allFleetCell(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('key') key: string,
    @Query('day') dayRaw: string,
    @Query('mode') mode?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    const day = parseDay(dayRaw);
    if (!key) throw new BadRequestException('key is required');
    const cell = await this.allFleet.cell(
      partnerId,
      period.month,
      period.year,
      key,
      day,
      parseMonitoringMode(mode),
    );
    if (!cell) throw new NotFoundException('No transactions for that subject/day');
    return cell;
  }

  @Get('gojek/grid')
  @ApiOperation({ summary: 'Own Gojek 31-day deposit grid (scoped to registered plates)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  gojekGrid(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('mode') mode?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    return this.fleet.gojekGrid(partnerId, period.month, period.year, parseMonitoringMode(mode));
  }

  @Get('gojek/cell')
  @ApiOperation({ summary: 'Own Gojek vehicle+day breakdown' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({
    name: 'plate',
    description: 'Row key: normalized plate, or drv:<NAME> when mode=driver',
  })
  @ApiQuery({ name: 'day', type: Number, example: 15 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  async gojekCell(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('plate') plate: string,
    @Query('day') dayRaw: string,
    @Query('mode') mode?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    const day = parseDay(dayRaw);
    if (!plate) throw new BadRequestException('plate is required');
    const cell = await this.fleet.gojekCell(
      partnerId,
      period.month,
      period.year,
      plate,
      day,
      parseMonitoringMode(mode),
    );
    if (!cell) throw new NotFoundException('No transactions for that vehicle/day');
    return cell;
  }

  @Get('gojek/summary')
  @ApiOperation({ summary: 'Own Gojek dashboard aggregates (cards + driver activity + charts)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({ name: 'day', type: Number, required: false, example: 15 })
  gojekSummary(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('day') dayRaw?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    const day = dayRaw ? Number(dayRaw) : undefined;
    if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 31)) {
      throw new BadRequestException('day must be an integer 1..31');
    }
    return this.fleet.gojekSummary(partnerId, period.month, period.year, day);
  }

  @Get('gojek/exceptions')
  @ApiOperation({ summary: 'Own exception schedule (Kelola Jadwal) for a period' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  gojekExceptions(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    return this.fleet.listExceptions(partnerId, period.month, period.year);
  }

  @Post('gojek/exceptions')
  @ApiOperation({ summary: 'Mark an exception on an own plate (rental / maintenance / free-day)' })
  createGojekException(@CurrentUser() user: SessionUser, @Body() dto: CreateExceptionDto) {
    const partnerId = requirePartner(user);
    return this.fleet.createException(partnerId, dto);
  }

  @Delete('gojek/exceptions/:id')
  @ApiOperation({ summary: 'Delete an own-plate exception' })
  deleteGojekException(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    const partnerId = requirePartner(user);
    return this.fleet.removeException(partnerId, id);
  }

  @Get('grab/grid')
  @ApiOperation({ summary: 'Own Grab earnings grid (scoped to registered plates)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  grabGrid(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('mode') mode?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    return this.fleet.grabGrid(partnerId, period.month, period.year, parseMonitoringMode(mode));
  }

  @Get('grab/cell')
  @ApiOperation({ summary: 'Own Grab driver whole-month performance detail' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({
    name: 'compositeKey',
    description: 'plate|city|driver, or drv:<NAME> when mode=driver',
  })
  @ApiQuery({ name: 'day', type: Number, required: false, example: 1 })
  @ApiQuery({ name: 'mode', required: false, enum: MONITORING_MODES })
  async grabCell(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('compositeKey') compositeKey: string,
    @Query('mode') mode?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    if (!compositeKey) throw new BadRequestException('compositeKey is required');
    const detail = await this.fleet.grabCell(
      partnerId,
      period.month,
      period.year,
      compositeKey,
      parseMonitoringMode(mode),
    );
    if (!detail) throw new NotFoundException('No data for that key');
    return detail;
  }
}
