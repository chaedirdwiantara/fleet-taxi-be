import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { requirePartner } from '../partner-portal/portal.util';
import { CreateRentalDto } from './dto/create-rental.dto';
import { PresignRentalProofDto } from './dto/presign-rental-proof.dto';
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto';
import { UpdateInvoiceSettingsDto } from './dto/update-invoice-settings.dto';
import { UpdateTaxSettingsDto } from './dto/update-tax-settings.dto';
import { UpsertCogsDefaultDto } from './dto/upsert-cogs-default.dto';
import { ListRentalsFilters, PartnerRentalsService } from './partner-rentals.service';
import { RentalCogsDefaultsService } from './rental-cogs-defaults.service';
import { invoiceFileName } from './rental-invoice';
import { RentalInvoicePdfService } from './rental-invoice-pdf.service';
import {
  INVOICE_ASSET_CONTENT_TYPE,
  INVOICE_ASSET_KINDS,
  InvoiceAssetKind,
} from './rental-invoice-settings.constants';
import { RentalInvoiceSettingsService } from './rental-invoice-settings.service';
import { RentalPaymentProofsService } from './rental-payment-proofs.service';
import { RentalTaxSettingsService } from './rental-tax-settings.service';
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

function parseAssetKind(raw: string): InvoiceAssetKind {
  if (!(INVOICE_ASSET_KINDS as readonly string[]).includes(raw)) {
    throw new BadRequestException(`kind must be one of: ${INVOICE_ASSET_KINDS.join(', ')}`);
  }
  return raw as InvoiceAssetKind;
}

/** `?signed=true|1` — anything else is the plain, unsigned document. */
function parseSigned(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

const ASSET_KIND_PARAM = {
  name: 'kind',
  enum: INVOICE_ASSET_KINDS,
  description: 'signature = tanda tangan, stamp = stempel',
};

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
    private readonly proofs: RentalPaymentProofsService,
    private readonly invoicePdf: RentalInvoicePdfService,
    private readonly invoiceSettings: RentalInvoiceSettingsService,
    private readonly taxSettings: RentalTaxSettingsService,
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

  @Delete('cogs-defaults/:key')
  @ApiOperation({ summary: 'Delete one COGS default (refused when it is the last one)' })
  removeCogsDefault(@CurrentUser() user: SessionUser, @Param('key') key: string) {
    return this.cogsDefaults.remove(requirePartner(user), key);
  }

  @Get('tax-settings')
  @ApiOperation({ summary: "The partner's PKP status, NPWP, and the PPN rate new rentals get" })
  getTaxSettings(@CurrentUser() user: SessionUser) {
    return this.taxSettings.get(requirePartner(user));
  }

  @Put('tax-settings')
  @ApiOperation({ summary: 'Turn PPN on/off for future rentals and set the NPWP' })
  updateTaxSettings(@CurrentUser() user: SessionUser, @Body() dto: UpdateTaxSettingsDto) {
    return this.taxSettings.update(requirePartner(user), dto);
  }

  @Get('invoice-settings')
  @ApiOperation({ summary: "Who signs the partner's invoices, and the uploaded signature/stamp" })
  getInvoiceSettings(@CurrentUser() user: SessionUser) {
    return this.invoiceSettings.get(requirePartner(user));
  }

  @Put('invoice-settings')
  @ApiOperation({ summary: 'Set the signatory name and title printed on invoices' })
  updateInvoiceSettings(@CurrentUser() user: SessionUser, @Body() dto: UpdateInvoiceSettingsDto) {
    return this.invoiceSettings.update(requirePartner(user), dto);
  }

  @Put('invoice-settings/:kind')
  @ApiOperation({ summary: 'Upload (replace) the PNG signature or stamp artwork' })
  @ApiParam(ASSET_KIND_PARAM)
  @ApiConsumes(INVOICE_ASSET_CONTENT_TYPE)
  uploadInvoiceAsset(
    @CurrentUser() user: SessionUser,
    @Param('kind') kind: string,
    @Req() req: Request,
  ) {
    // Raw body via the route-scoped express.raw() in app.setup.ts
    return this.invoiceSettings.storeAsset(
      requirePartner(user),
      parseAssetKind(kind),
      req.headers['content-type'],
      req.body as Buffer | undefined,
    );
  }

  @Delete('invoice-settings/:kind')
  @ApiOperation({ summary: 'Remove the signature or stamp artwork' })
  @ApiParam(ASSET_KIND_PARAM)
  removeInvoiceAsset(@CurrentUser() user: SessionUser, @Param('kind') kind: string) {
    return this.invoiceSettings.removeAsset(requirePartner(user), parseAssetKind(kind));
  }

  @Get('invoice-settings/:kind/file')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Stream the signature or stamp PNG (dev; prod settings carry presigned S3 URLs)',
  })
  @ApiParam(ASSET_KIND_PARAM)
  async invoiceAssetFile(
    @CurrentUser() user: SessionUser,
    @Param('kind') kind: string,
  ): Promise<StreamableFile> {
    const { contentType, body } = await this.invoiceSettings.assetFile(
      requirePartner(user),
      parseAssetKind(kind),
    );
    return new StreamableFile(body, { type: contentType });
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

  // ---- payment evidence ------------------------------------------------------
  // Presign → PUT → confirm, like driver documents. These live under the
  // STATIC 'proofs' segment and must stay above the :id routes below, or
  // Express hands 'proofs' to ParseIntPipe and every call 400s.

  @Post('proofs/presign')
  @ApiOperation({
    summary: 'Create a pending payment-proof row and get an upload URL (S3 presigned PUT in prod)',
  })
  presignProof(@CurrentUser() user: SessionUser, @Body() dto: PresignRentalProofDto) {
    return this.proofs.presign(user, requirePartner(user), dto);
  }

  @Post('proofs/:proofId/confirm')
  @ApiOperation({ summary: 'Confirm a payment-proof upload finished (marks it uploaded)' })
  confirmProof(@CurrentUser() user: SessionUser, @Param('proofId', ParseIntPipe) proofId: number) {
    return this.proofs.confirm(requirePartner(user), proofId);
  }

  @Delete('proofs/:proofId')
  @ApiOperation({
    summary: 'Delete one payment proof (refused if it is the last one of a paid rental)',
  })
  removeProof(@CurrentUser() user: SessionUser, @Param('proofId', ParseIntPipe) proofId: number) {
    return this.proofs.remove(requirePartner(user), proofId);
  }

  @Put('proofs/:proofId/upload')
  @ApiOperation({ summary: 'Upload sink for presigned payment proofs (dev; prod presigns S3)' })
  @ApiConsumes('image/jpeg', 'image/png', 'application/pdf')
  uploadProof(
    @CurrentUser() user: SessionUser,
    @Param('proofId', ParseIntPipe) proofId: number,
    @Req() req: Request,
  ) {
    // Raw body via the route-scoped express.raw() in app.setup.ts
    return this.proofs.storeUploaded(
      requirePartner(user),
      proofId,
      req.headers['content-type'],
      req.body as Buffer,
    );
  }

  @Get('proofs/:proofId/file')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary: 'Stream one payment proof (dev; prod responses carry presigned S3 GET URLs)',
  })
  async proofFile(
    @CurrentUser() user: SessionUser,
    @Param('proofId', ParseIntPipe) proofId: number,
  ): Promise<StreamableFile> {
    const { contentType, body } = await this.proofs.file(requirePartner(user), proofId);
    return new StreamableFile(body, { type: contentType });
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
  @ApiOperation({
    summary: 'Create a rental transaction (a same-plate date overlap needs allowOverlap)',
  })
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
    return this.rentalsService.updatePaymentStatus(
      requirePartner(user),
      id,
      dto.paymentStatus,
      dto.paymentProofIds,
    );
  }

  @Get(':id/invoice')
  @ApiOperation({ summary: 'Download the PDF invoice of one own PAID rental' })
  @ApiQuery({
    name: 'signed',
    required: false,
    type: Boolean,
    description: 'true = embed the uploaded signature and stamp (409 when no signature is set)',
  })
  async invoice(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('signed') signedRaw?: string,
  ): Promise<StreamableFile> {
    const partnerId = requirePartner(user);
    const invoice = await this.rentalsService.invoiceFor(partnerId, id);
    const signing = parseSigned(signedRaw)
      ? await this.invoiceSettings.signingAssets(partnerId)
      : null;
    const buffer = await this.invoicePdf.toPdf(invoice, signing);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${invoiceFileName(invoice.invoiceNumber)}"`,
    });
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
