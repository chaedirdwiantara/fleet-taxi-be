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
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePeriod, toStringArray } from '../common/util/period';
import { CreateExceptionDto } from './dto/fleet.dto';
import { ExceptionsService } from './exceptions.service';
import { toCellBreakdown, toFleetGrid, toGojekSummary, toPerformers } from './fleet-presenter';
import { GojekGridService } from './gojek-grid.service';

@ApiTags('admin-fleet-gojek')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/fleet/gojek')
export class GojekController {
  constructor(
    private readonly gridService: GojekGridService,
    private readonly exceptionsService: ExceptionsService,
  ) {}

  @Get('grid')
  @CheckPolicies((a) => a.can('read', 'FleetImport'))
  @ApiOperation({ summary: '31-day deposit pivot grid (rows = vehicles)' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  @ApiQuery({ name: 'rentalPartner', required: false, isArray: true, type: String })
  @ApiQuery({ name: 'plate', required: false, type: String })
  async grid(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('rentalPartner') rentalPartner?: string | string[],
    @Query('plate') plate?: string,
  ) {
    const period = parsePeriod(month, year);
    const result = await this.gridService.buildGrid(period.month, period.year, {
      rentalPartners: toStringArray(rentalPartner),
      plate,
    });
    return toFleetGrid(result);
  }

  @Get('cell')
  @CheckPolicies((a) => a.can('read', 'FleetImport'))
  @ApiOperation({ summary: 'One vehicle+day transaction breakdown (cell-click modal)' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  @ApiQuery({ name: 'plate', description: 'Row key: normalized plate or manual_<detailId>' })
  @ApiQuery({ name: 'day', example: 15 })
  async cell(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('plate') plate: string,
    @Query('day') dayRaw: string,
  ) {
    const period = parsePeriod(month, year);
    const day = Number(dayRaw);
    if (!plate) throw new BadRequestException('plate is required');
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new BadRequestException('day must be an integer 1..31');
    }
    const bucket = await this.gridService.getCell(period.month, period.year, plate, day);
    if (!bucket) throw new NotFoundException('No transactions for that vehicle/day');
    return toCellBreakdown(bucket, plate, day);
  }

  @Get('summary')
  @CheckPolicies((a) => a.can('read', 'FleetImport'))
  @ApiOperation({ summary: 'Dashboard aggregates: summary cards + driver activity + charts' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  @ApiQuery({ name: 'day', required: false, example: 15 })
  async summary(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('day') dayRaw?: string,
  ) {
    const period = parsePeriod(month, year);
    const grid = await this.gridService.buildGrid(period.month, period.year);
    const day = dayRaw ? Number(dayRaw) : undefined;
    return toGojekSummary(grid, day);
  }

  @Get('performers')
  @CheckPolicies((a) => a.can('read', 'FleetImport'))
  @ApiOperation({ summary: 'Top/bottom 10 drivers by outstanding' })
  async performers(@Query('month') month: string, @Query('year') year: string) {
    const period = parsePeriod(month, year);
    const grid = await this.gridService.buildGrid(period.month, period.year);
    return toPerformers({
      topPerformers: grid.topPerformers,
      bottomPerformers: grid.bottomPerformers,
    });
  }

  @Get('exceptions')
  @CheckPolicies((a) => a.can('read', 'FleetException'))
  @ApiOperation({ summary: 'List exceptions for a period' })
  exceptions(@Query('month') month: string, @Query('year') year: string) {
    const period = parsePeriod(month, year);
    return this.exceptionsService.list(period.month, period.year);
  }

  @Post('exceptions')
  @CheckPolicies((a) => a.can('create', 'FleetException'))
  @ApiOperation({ summary: 'Mark an exception (rental / maintenance / free-day)' })
  createException(@Body() dto: CreateExceptionDto) {
    return this.exceptionsService.create(dto);
  }

  @Delete('exceptions/:id')
  @CheckPolicies((a) => a.can('delete', 'FleetException'))
  @ApiOperation({ summary: 'Delete an exception' })
  deleteException(@Param('id', ParseIntPipe) id: number) {
    return this.exceptionsService.remove(id);
  }
}
