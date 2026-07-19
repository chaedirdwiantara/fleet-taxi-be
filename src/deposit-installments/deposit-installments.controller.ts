import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { requirePartner } from '../partner-portal/portal.util';
import { DepositInstallmentsService } from './deposit-installments.service';
import { CreateDepositInstallmentDto } from './dto/create-deposit-installment.dto';
import {
  INSTALLMENT_SORT_FIELDS,
  type InstallmentQuery,
  type InstallmentSortField,
} from './installment-presenter';

const ListQueries = () =>
  applyDecorators(
    ApiQuery({ name: 'status', required: false, enum: ['berjalan', 'lunas'] }),
    ApiQuery({ name: 'search', required: false, description: 'Substring on title/driver/plate' }),
    ApiQuery({ name: 'sortBy', required: false, enum: [...INSTALLMENT_SORT_FIELDS] }),
    ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] }),
  );

function parseListQuery(raw: {
  status?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}): InstallmentQuery {
  if (raw.status !== undefined && raw.status !== 'berjalan' && raw.status !== 'lunas') {
    throw new BadRequestException('status must be berjalan or lunas');
  }
  if (
    raw.sortBy !== undefined &&
    !INSTALLMENT_SORT_FIELDS.includes(raw.sortBy as InstallmentSortField)
  ) {
    throw new BadRequestException(`sortBy must be one of: ${INSTALLMENT_SORT_FIELDS.join(', ')}`);
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== 'asc' && raw.sortOrder !== 'desc') {
    throw new BadRequestException('sortOrder must be asc or desc');
  }
  return {
    status: raw.status,
    search: raw.search || undefined,
    sortBy: (raw.sortBy as InstallmentSortField | undefined) ?? 'createdAt',
    sortOrder: raw.sortOrder ?? 'desc',
  };
}

/**
 * Cicilan Deposit (partner portal) — installment rules per driver, with the
 * payment history derived live from fleet imports (installment-presenter.ts).
 * Static routes (driver-options) are declared BEFORE the parameterized :id
 * routes so Express never captures them as an id.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/deposit-installments')
export class DepositInstallmentsController {
  constructor(private readonly installments: DepositInstallmentsService) {}

  @Get('driver-options')
  @ApiOperation({ summary: 'Distinct driver names on own plates (feeds the driver picker)' })
  driverOptions(@CurrentUser() user: SessionUser) {
    return this.installments.driverOptions(requirePartner(user));
  }

  @Get()
  @ApiOperation({ summary: 'Own cicilan-deposit rules with derived payment progress' })
  @ListQueries()
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 10 })
  list(
    @CurrentUser() user: SessionUser,
    @Query() raw: Record<string, string | undefined>,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const partnerId = requirePartner(user);
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.installments.list(partnerId, parseListQuery(raw), page, pageSize);
  }

  @Post()
  @ApiOperation({ summary: 'Create a cicilan-deposit rule' })
  create(@CurrentUser() user: SessionUser, @Body() dto: CreateDepositInstallmentDto) {
    return this.installments.create(requirePartner(user), dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edit one own cicilan-deposit rule' })
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateDepositInstallmentDto,
  ) {
    return this.installments.update(requirePartner(user), id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete one own cicilan-deposit rule' })
  remove(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.installments.remove(requirePartner(user), id);
  }

  @Get(':id/recap')
  @ApiOperation({ summary: 'Rekap: derived installment history of one own rule' })
  recap(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.installments.recap(requirePartner(user), id);
  }
}
