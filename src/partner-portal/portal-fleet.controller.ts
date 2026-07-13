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
import { parsePeriod } from '../common/util/period';
import { CreateExceptionDto } from '../fleet/dto/fleet.dto';
import { PortalFleetService } from './portal-fleet.service';
import { requirePartner } from './portal.util';

/**
 * Partner-scoped fleet monitoring (Gojek + Grab). Mirrors the admin fleet
 * endpoints' response shapes so the frontend reuses the same components, but
 * the data is filtered to the partner's own registered plates. Read-only
 * except the exception schedule (Kelola Jadwal), which partners manage for
 * their own plates.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/fleet')
export class PortalFleetController {
  constructor(private readonly fleet: PortalFleetService) {}

  @Get('gojek/grid')
  @ApiOperation({ summary: 'Own Gojek 31-day deposit grid (scoped to registered plates)' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  gojekGrid(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    return this.fleet.gojekGrid(partnerId, period.month, period.year);
  }

  @Get('gojek/cell')
  @ApiOperation({ summary: 'Own Gojek vehicle+day breakdown' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  @ApiQuery({ name: 'plate', description: 'Row key: normalized plate or manual_<detailId>' })
  @ApiQuery({ name: 'day', example: 15 })
  async gojekCell(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('plate') plate: string,
    @Query('day') dayRaw: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    const day = Number(dayRaw);
    if (!plate) throw new BadRequestException('plate is required');
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new BadRequestException('day must be an integer 1..31');
    }
    const cell = await this.fleet.gojekCell(partnerId, period.month, period.year, plate, day);
    if (!cell) throw new NotFoundException('No transactions for that vehicle/day');
    return cell;
  }

  @Get('gojek/summary')
  @ApiOperation({ summary: 'Own Gojek dashboard aggregates (cards + driver activity + charts)' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  @ApiQuery({ name: 'day', required: false, example: 15 })
  gojekSummary(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('day') dayRaw?: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    const day = dayRaw ? Number(dayRaw) : undefined;
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
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  grabGrid(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    return this.fleet.grabGrid(partnerId, period.month, period.year);
  }

  @Get('grab/cell')
  @ApiOperation({ summary: 'Own Grab driver whole-month performance detail' })
  @ApiQuery({ name: 'month', example: 7 })
  @ApiQuery({ name: 'year', example: 2026 })
  @ApiQuery({ name: 'compositeKey', description: 'plate|city|driver' })
  @ApiQuery({ name: 'day', required: false, example: 1 })
  async grabCell(
    @CurrentUser() user: SessionUser,
    @Query('month') month: string,
    @Query('year') year: string,
    @Query('compositeKey') compositeKey: string,
  ) {
    const partnerId = requirePartner(user);
    const period = parsePeriod(month, year);
    if (!compositeKey) throw new BadRequestException('compositeKey is required');
    const detail = await this.fleet.grabCell(partnerId, period.month, period.year, compositeKey);
    if (!detail) throw new NotFoundException('No data for that key');
    return detail;
  }
}
