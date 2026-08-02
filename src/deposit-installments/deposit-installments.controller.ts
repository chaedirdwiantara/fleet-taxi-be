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
import { COP_SORT_FIELDS, type CopQuery, type CopSortField } from './cop-presenter';
import { DepositInstallmentsService } from './deposit-installments.service';
import { CreateDepositInstallmentDto } from './dto/create-deposit-installment.dto';
import {
  INSTALLMENT_SORT_FIELDS,
  type InstallmentQuery,
  type InstallmentSortField,
  type InstallmentStatus,
} from './installment-presenter';

type RawListQuery = {
  status?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
};

const ListQueries = () =>
  applyDecorators(
    ApiQuery({ name: 'status', required: false, enum: ['berjalan', 'lunas'] }),
    ApiQuery({ name: 'search', required: false, description: 'Substring on title/driver/plate' }),
    ApiQuery({ name: 'sortBy', required: false, enum: [...INSTALLMENT_SORT_FIELDS] }),
    ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] }),
  );

const CopQueries = () =>
  applyDecorators(
    ApiQuery({ name: 'status', required: false, enum: ['berjalan', 'lunas'] }),
    ApiQuery({ name: 'search', required: false, description: 'Substring on driver/plate' }),
    ApiQuery({ name: 'sortBy', required: false, enum: [...COP_SORT_FIELDS] }),
    ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] }),
  );

/** Shared by both query parsers — the enums differ, the rules do not. */
function parseStatus(raw?: string): InstallmentStatus | undefined {
  if (raw !== undefined && raw !== 'berjalan' && raw !== 'lunas') {
    throw new BadRequestException('status must be berjalan or lunas');
  }
  return raw;
}

function parseSortOrder(raw?: string): 'asc' | 'desc' | undefined {
  if (raw !== undefined && raw !== 'asc' && raw !== 'desc') {
    throw new BadRequestException('sortOrder must be asc or desc');
  }
  return raw;
}

function parseListQuery(raw: RawListQuery): InstallmentQuery {
  if (
    raw.sortBy !== undefined &&
    !INSTALLMENT_SORT_FIELDS.includes(raw.sortBy as InstallmentSortField)
  ) {
    throw new BadRequestException(`sortBy must be one of: ${INSTALLMENT_SORT_FIELDS.join(', ')}`);
  }
  return {
    status: parseStatus(raw.status),
    search: raw.search || undefined,
    sortBy: (raw.sortBy as InstallmentSortField | undefined) ?? 'createdAt',
    sortOrder: parseSortOrder(raw.sortOrder) ?? 'desc',
  };
}

function parseCopQuery(raw: RawListQuery): CopQuery {
  if (raw.sortBy !== undefined && !COP_SORT_FIELDS.includes(raw.sortBy as CopSortField)) {
    throw new BadRequestException(`sortBy must be one of: ${COP_SORT_FIELDS.join(', ')}`);
  }
  return {
    status: parseStatus(raw.status),
    search: raw.search || undefined,
    // biggest debt first — the report exists to surface who is behind
    sortBy: (raw.sortBy as CopSortField | undefined) ?? 'remaining',
    sortOrder: parseSortOrder(raw.sortOrder) ?? 'desc',
  };
}

/**
 * Cicilan (partner portal) — installment rules per driver, with the payment
 * history derived live from fleet imports (installment-presenter.ts), plus the
 * read-only Car Ownership Program report over the COP-titled subset
 * (cop-presenter.ts). Static routes (driver-options, cop) are declared BEFORE
 * the parameterized :id routes so Express never captures them as an id.
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

  @Get('cop')
  @ApiOperation({
    summary: 'Car Ownership Program report: own COP-titled rules with programme figures',
  })
  @CopQueries()
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 10 })
  listCop(
    @CurrentUser() user: SessionUser,
    @Query() raw: Record<string, string | undefined>,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ) {
    const partnerId = requirePartner(user);
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.installments.listCop(partnerId, parseCopQuery(raw), page, pageSize);
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
