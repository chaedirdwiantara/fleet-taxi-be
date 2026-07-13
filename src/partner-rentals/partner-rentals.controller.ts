import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { requirePartner } from '../partner-portal/portal.util';
import { CreateRentalDto } from './dto/create-rental.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { UpsertCogsDefaultDto } from './dto/upsert-cogs-default.dto';
import { ListRentalsFilters, PartnerRentalsService } from './partner-rentals.service';
import { RentalCogsDefaultsService } from './rental-cogs-defaults.service';
import { RentalsExportService } from './rentals-export.service';

const LIST_QUERIES = [
  {
    name: 'month',
    required: false,
    type: Number,
    example: 7,
    description: '1..12, default current WIB month',
  },
  {
    name: 'year',
    required: false,
    type: Number,
    example: 2026,
    description: 'Default current WIB year',
  },
  { name: 'region', required: false, description: 'Exact region; absent/empty = all' },
  { name: 'search', required: false, description: 'Substring on plate/customer/service area' },
  { name: 'sortBy', required: false, enum: ['date', 'duration', 'status', 'omset', 'cogs'] },
  { name: 'sortOrder', required: false, enum: ['asc', 'desc'] },
];

function parseOptionalInt(name: string, raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new BadRequestException(`${name} must be an integer`);
  return n;
}

/**
 * Rental Monitoring (legacy admin/jadwal-mobil-cogs, ported into the partner
 * portal). Static routes (cogs-defaults, export) are declared BEFORE the
 * parameterized :id routes so Express never captures them as an id.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/rentals')
export class PartnerRentalsController {
  constructor(
    private readonly rentalsService: PartnerRentalsService,
    private readonly cogsDefaults: RentalCogsDefaultsService,
    private readonly exportService: RentalsExportService,
  ) {}

  @Get('cogs-defaults')
  @ApiOperation({ summary: 'Per-partner default COGS/day per vehicle type (lazy-seeded)' })
  listCogsDefaults(@CurrentUser() user: SessionUser) {
    return this.cogsDefaults.list(requirePartner(user));
  }

  @Put('cogs-defaults')
  @ApiOperation({ summary: 'Upsert one COGS default (key present → update, absent → create)' })
  upsertCogsDefault(@CurrentUser() user: SessionUser, @Body() dto: UpsertCogsDefaultDto) {
    return this.cogsDefaults.upsert(requirePartner(user), dto);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export the monthly rental recap (?format=pdf|xlsx)' })
  @ApiQuery({ name: 'format', enum: ['xlsx', 'pdf'] })
  @ApiQuery(LIST_QUERIES[0]!)
  @ApiQuery(LIST_QUERIES[1]!)
  @ApiQuery(LIST_QUERIES[2]!)
  @ApiQuery(LIST_QUERIES[3]!)
  @ApiQuery(LIST_QUERIES[4]!)
  @ApiQuery(LIST_QUERIES[5]!)
  async export(
    @CurrentUser() user: SessionUser,
    @Query('format') format?: string,
    @Query('month') monthRaw?: string,
    @Query('year') yearRaw?: string,
    @Query('region') region?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ): Promise<StreamableFile> {
    const partnerId = requirePartner(user);
    if (format !== 'xlsx' && format !== 'pdf') {
      throw new BadRequestException('format must be xlsx or pdf');
    }
    const filters = this.parseFilters(monthRaw, yearRaw, region, search, sortBy, sortOrder);
    const period = this.rentalsService.resolvePeriod(filters);
    const { summary, items } = await this.rentalsService.list(partnerId, filters);

    const mm = String(period.month).padStart(2, '0');
    const filename = `rental-monitoring-${period.year}-${mm}.${format}`;
    const title = `Rental Monitoring — ${period.year}-${mm}`;
    const buffer =
      format === 'xlsx'
        ? await this.exportService.rentalsToXlsx(title, items, summary)
        : await this.exportService.rentalsToPdf(title, items, summary);
    return new StreamableFile(buffer, {
      type:
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Monthly rental recap: summary, nett per type, regions, items' })
  @ApiQuery(LIST_QUERIES[0]!)
  @ApiQuery(LIST_QUERIES[1]!)
  @ApiQuery(LIST_QUERIES[2]!)
  @ApiQuery(LIST_QUERIES[3]!)
  @ApiQuery(LIST_QUERIES[4]!)
  @ApiQuery(LIST_QUERIES[5]!)
  list(
    @CurrentUser() user: SessionUser,
    @Query('month') monthRaw?: string,
    @Query('year') yearRaw?: string,
    @Query('region') region?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.rentalsService.list(
      requirePartner(user),
      this.parseFilters(monthRaw, yearRaw, region, search, sortBy, sortOrder),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a rental transaction (overlap-guarded per plate)' })
  create(@CurrentUser() user: SessionUser, @Body() dto: CreateRentalDto) {
    return this.rentalsService.create(requirePartner(user), dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Edit one own rental transaction' })
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateRentalDto,
  ) {
    return this.rentalsService.update(requirePartner(user), id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete one own rental transaction' })
  remove(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.rentalsService.remove(requirePartner(user), id);
  }

  @Patch(':id/payment-status')
  @ApiOperation({ summary: 'Toggle Belum/Sudah Dibayar on one own rental' })
  updatePaymentStatus(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePaymentStatusDto,
  ) {
    return this.rentalsService.updatePaymentStatus(requirePartner(user), id, dto.paymentStatus);
  }

  private parseFilters(
    monthRaw?: string,
    yearRaw?: string,
    region?: string,
    search?: string,
    sortBy?: string,
    sortOrder?: string,
  ): ListRentalsFilters {
    return {
      month: parseOptionalInt('month', monthRaw),
      year: parseOptionalInt('year', yearRaw),
      region,
      search,
      sortBy,
      sortOrder,
    };
  }
}
