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
import { parsePeriod } from '../common/util/period';
import { GrabGridService } from './grab-grid.service';

@ApiTags('admin-fleet-grab')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/fleet/grab')
export class GrabController {
  constructor(private readonly gridService: GrabGridService) {}

  @Get('grid')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: '31-day earnings pivot grid (composite key plate|city|driver)' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  grid(@Query('month') month: string, @Query('year') year: string) {
    const period = parsePeriod(month, year);
    return this.gridService.buildGrid(period.month, period.year);
  }

  @Get('cell')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: 'One composite-key+day breakdown' })
  @ApiQuery({ name: 'key', description: 'plate|city|driver' })
  @ApiQuery({ name: 'day', example: 15 })
  async cell(
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('key') key: string,
    @Query('day') dayRaw: string,
  ) {
    const period = parsePeriod(month, year);
    const day = Number(dayRaw);
    if (!key) throw new BadRequestException('key is required');
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new BadRequestException('day must be an integer 1..31');
    }
    const cell = await this.gridService.getCell(period.month, period.year, key, day);
    if (!cell) throw new NotFoundException('No data for that key/day');
    return cell;
  }

  @Get('performers')
  @CheckPolicies((a) => a.can('read', 'GrabImport'))
  @ApiOperation({ summary: 'Top/bottom 10 by total earning collected' })
  async performers(@Query('month') month: string, @Query('year') year: string) {
    const period = parsePeriod(month, year);
    const grid = await this.gridService.buildGrid(period.month, period.year);
    const sorted = [...grid.rows].sort((a, b) => b.totalEarningCollected - a.totalEarningCollected);
    return {
      topPerformers: sorted.slice(0, 10),
      bottomPerformers: sorted.slice(-10).reverse(),
    };
  }
}
