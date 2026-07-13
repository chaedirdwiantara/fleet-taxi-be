import {
  Body,
  Controller,
  Delete,
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
import { CreateDriverRegistrationDto } from './dto/create-driver-registration.dto';
import { DriverDecisionDto, VerifyDriverRegistrationDto } from './dto/driver-decision.dto';
import { DriverDocCheckDto } from './dto/driver-doc-check.dto';
import { SetDriverDepositDto } from './dto/set-driver-deposit.dto';
import { UpdateDriverRegistrationDto } from './dto/update-driver-registration.dto';
import { PartnerDriversService } from './partner-drivers.service';
import { requirePartner } from '../partner-portal/portal.util';

/** Driver registrations: the pending/rejected slice of the drivers table. */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/driver-registrations')
export class PortalDriverRegistrationsController {
  constructor(private readonly drivers: PartnerDriversService) {}

  @Get()
  @ApiOperation({ summary: 'List own driver registrations (pending/rejected, paginated)' })
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
    return this.drivers.listRegistrations(requirePartner(user), { page, pageSize, q });
  }

  @Post()
  @ApiOperation({ summary: 'Register a driver candidate (plate must be registered when set)' })
  create(@CurrentUser() user: SessionUser, @Body() dto: CreateDriverRegistrationDto) {
    return this.drivers.createRegistration(requirePartner(user), dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One own registration incl. documents' })
  detail(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.registrationDetail(requirePartner(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit registration master data' })
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDriverRegistrationDto,
  ) {
    return this.drivers.updateRegistration(requirePartner(user), id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an unapproved registration (hard delete incl. documents)' })
  remove(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.drivers.removeRegistration(requirePartner(user), id);
  }

  @Post(':id/doc-check')
  @ApiOperation({ summary: 'Record the KTP/SIM/SKCK verification result' })
  docCheck(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DriverDocCheckDto,
  ) {
    return this.drivers.docCheck(requirePartner(user), id, dto);
  }

  @Post(':id/deposit')
  @ApiOperation({ summary: 'Record the deposit amount (requires an uploaded deposit proof)' })
  setDeposit(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetDriverDepositDto,
  ) {
    return this.drivers.setDeposit(requirePartner(user), id, dto);
  }

  @Post(':id/deposit/decision')
  @ApiOperation({ summary: 'Approve/reject the waiting deposit' })
  decideDeposit(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DriverDecisionDto,
  ) {
    return this.drivers.decideDeposit(requirePartner(user), id, dto);
  }

  @Post(':id/verify')
  @ApiOperation({
    summary: 'Final verification: approve (assigns driver code) or reject the registration',
  })
  verify(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VerifyDriverRegistrationDto,
  ) {
    return this.drivers.verifyRegistration(requirePartner(user), id, dto);
  }
}
