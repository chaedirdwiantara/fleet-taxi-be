import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { DriverSyncService } from './driver-sync.service';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { PartnerDriversService } from './partner-drivers.service';
import { requirePartner } from '../partner-portal/portal.util';

/**
 * Driver roster synced from the fleet-monitoring import data (Gojek/Grab).
 * Listing auto-syncs first, so new drivers in the import appear without any
 * manual registration; completeness and lifecycle changes go through PATCH.
 * Deliberately no POST/DELETE — the import data is the source of truth.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/drivers')
export class PortalDriversController {
  constructor(
    private readonly drivers: PartnerDriversService,
    private readonly sync: DriverSyncService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Sync the roster from fleet imports, then list own drivers (paginated, filterable)',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Search name / driver code / email' })
  @ApiQuery({ name: 'plate', required: false })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'resigned', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  async list(
    @CurrentUser() user: SessionUser,
    @Query('q') q?: string,
    @Query('plate') plate?: string,
    @Query('active') active?: string,
    @Query('resigned') resigned?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const partnerId = requirePartner(user);
    await this.sync.syncFromFleet(partnerId);
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.drivers.listDrivers(partnerId, { page, pageSize, q, plate, active, resigned });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One own driver incl. documents' })
  detail(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.driverDetail(requirePartner(user), id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit driver master data / lifecycle (resign, deposit return, isActive)',
  })
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.drivers.updateDriver(requirePartner(user), id, dto);
  }
}
