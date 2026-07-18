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
import { parsePeriod, toStringArray } from '../common/util/period';
import { GrabGridService } from './grab-grid.service';
import { toGrabDriverDetail, toGrabGrid, toGrabPerformers } from './grab-presenter';

@ApiTags('admin-fleet-grab')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/fleet/grab')
export class GrabController {
  constructor(private readonly gridService: GrabGridService) {}

  @Get('grid')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: '31-day earnings pivot grid (composite key plate|city|driver)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
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
    return toGrabGrid(result);
  }

  @Get('cell')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: 'Whole-month performance detail for one driver (eye modal)' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  @ApiQuery({ name: 'compositeKey', description: 'plate|city|driver' })
  @ApiQuery({ name: 'day', type: Number, required: false, example: 1 })
  async cell(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('compositeKey') compositeKey: string,
  ) {
    const period = parsePeriod(month, year);
    if (!compositeKey) throw new BadRequestException('compositeKey is required');
    const row = await this.gridService.findRow(period.month, period.year, compositeKey);
    if (!row) throw new NotFoundException('No data for that key');
    return toGrabDriverDetail(row);
  }

  @Get('performers')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: 'Top/bottom 10 by total earning collected' })
  @ApiQuery({ name: 'month', type: Number, example: 7 })
  @ApiQuery({ name: 'year', type: Number, example: 2026 })
  async performers(@Query('month') month: string, @Query('year') year: string) {
    const period = parsePeriod(month, year);
    const grid = await this.gridService.buildGrid(period.month, period.year);
    return toGrabPerformers(grid.rows);
  }
}
