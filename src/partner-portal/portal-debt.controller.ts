import {
  BadRequestException,
  Controller,
  Get,
  Query,
  StreamableFile,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { DebtExportService } from './debt-export.service';
import { DEBT_SORT_FIELDS, type DebtQuery, type DebtSortField } from './debt-presenter';
import { PortalDebtService } from './portal-debt.service';
import { requirePartner } from './portal.util';

/** Shared filter @ApiQuery specs — the list and export endpoints accept the same set. */
const DebtFilterQueries = () =>
  applyDecorators(
    ApiQuery({ name: 'status', required: false, enum: ['aktif', 'nonaktif'] }),
    ApiQuery({
      name: 'cabang',
      required: false,
      description: 'Exact cabang from /debt-summary/filters',
    }),
    ApiQuery({
      name: 'koordinator',
      required: false,
      description: 'Exact koordinator from /debt-summary/filters',
    }),
    ApiQuery({ name: 'search', required: false, description: 'Substring on driver name or plate' }),
    ApiQuery({ name: 'sortBy', required: false, enum: [...DEBT_SORT_FIELDS] }),
    ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] }),
  );

function parseDebtQuery(raw: {
  status?: string;
  cabang?: string;
  koordinator?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}): DebtQuery {
  if (raw.status !== undefined && raw.status !== 'aktif' && raw.status !== 'nonaktif') {
    throw new BadRequestException('status must be aktif or nonaktif');
  }
  if (raw.sortBy !== undefined && !DEBT_SORT_FIELDS.includes(raw.sortBy as DebtSortField)) {
    throw new BadRequestException(`sortBy must be one of: ${DEBT_SORT_FIELDS.join(', ')}`);
  }
  if (raw.sortOrder !== undefined && raw.sortOrder !== 'asc' && raw.sortOrder !== 'desc') {
    throw new BadRequestException('sortOrder must be asc or desc');
  }
  return {
    status: raw.status,
    cabang: raw.cabang || undefined,
    koordinator: raw.koordinator || undefined,
    search: raw.search || undefined,
    // default: the least-covered drivers (deposit paling tidak menutup tagihan) first
    sortBy: (raw.sortBy as DebtSortField | undefined) ?? 'selisihDeposit',
    sortOrder: raw.sortOrder ?? 'asc',
  };
}

/**
 * Read-only, partner-scoped Debt Summary. Aggregated live from the same
 * Gojek/Grab import data behind fleet monitoring; see portal-debt.service.ts
 * for the column mapping and debt-presenter.ts for the math.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/debt-summary')
export class PortalDebtController {
  constructor(
    private readonly debt: PortalDebtService,
    private readonly exportService: DebtExportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Own debt summary per driver (scoped to registered plates)' })
  @DebtFilterQueries()
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
    return this.debt.list(partnerId, parseDebtQuery(raw), page, pageSize);
  }

  @Get('filters')
  @ApiOperation({ summary: 'Dropdown options (cabang, koordinator) for the debt summary' })
  filters(@CurrentUser() user: SessionUser) {
    return this.debt.filters(requirePartner(user));
  }

  @Get('export')
  @ApiOperation({ summary: 'Export the filtered debt summary (?format=xlsx)' })
  @DebtFilterQueries()
  @ApiQuery({ name: 'format', enum: ['xlsx'] })
  async export(
    @CurrentUser() user: SessionUser,
    @Query() raw: Record<string, string | undefined>,
    @Query('format') format?: string,
  ): Promise<StreamableFile> {
    const partnerId = requirePartner(user);
    if (format !== 'xlsx') {
      throw new BadRequestException('format must be xlsx');
    }
    const rows = await this.debt.allForExport(partnerId, parseDebtQuery(raw));
    const buffer = await this.exportService.toXlsx(rows);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="debt-summary.xlsx"',
    });
  }
}
