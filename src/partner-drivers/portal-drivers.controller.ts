import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { PartnerDriversService } from './partner-drivers.service';
import { requirePartner } from '../partner-portal/portal.util';

/** Active driver roster: approved registrations that haven't resigned. */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/drivers')
export class PortalDriversController {
  constructor(private readonly drivers: PartnerDriversService) {}

  @Get()
  @ApiOperation({ summary: 'List own active drivers (paginated, filterable)' })
  @ApiQuery({ name: 'q', required: false, description: 'Search name / driver code / email' })
  @ApiQuery({ name: 'plate', required: false })
  @ApiQuery({ name: 'active', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  list(
    @CurrentUser() user: SessionUser,
    @Query('q') q?: string,
    @Query('plate') plate?: string,
    @Query('active') active?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.drivers.listDrivers(requirePartner(user), { page, pageSize, q, plate, active });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One own active driver incl. documents' })
  detail(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.driverDetail(requirePartner(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit driver master data / toggle isActive' })
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDriverDto,
  ) {
    return this.drivers.updateDriver(requirePartner(user), id, dto);
  }

  @Post(':id/resign')
  @ApiOperation({ summary: 'Resign the driver (moves them to the resignation list)' })
  resign(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.resign(requirePartner(user), id);
  }
}
