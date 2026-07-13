import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { DriverDecisionDto } from './dto/driver-decision.dto';
import { PartnerDriversService } from './partner-drivers.service';
import { requirePartner } from '../partner-portal/portal.util';

/** Resigned drivers + the deposit-return flow. */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/driver-resignations')
export class PortalDriverResignationsController {
  constructor(private readonly drivers: PartnerDriversService) {}

  @Get()
  @ApiOperation({ summary: 'List own resigned drivers (paginated, newest resignation first)' })
  @ApiQuery({ name: 'q', required: false, description: 'Search name / driver code' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  list(
    @CurrentUser() user: SessionUser,
    @Query('q') q?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.drivers.listResignations(requirePartner(user), { page, pageSize, q });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One own resignation incl. documents' })
  detail(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.resignationDetail(requirePartner(user), id);
  }

  @Post(':id/deposit-return')
  @ApiOperation({
    summary: 'Request the deposit return decision (requires an uploaded return proof)',
  })
  requestReturn(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.requestDepositReturn(requirePartner(user), id);
  }

  @Post(':id/deposit-return/decision')
  @ApiOperation({ summary: 'Approve/reject the waiting deposit return' })
  decideReturn(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DriverDecisionDto,
  ) {
    return this.drivers.decideDepositReturn(requirePartner(user), id, dto);
  }
}
