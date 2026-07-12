import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Patch,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { CHECKPOINT_POINT_KEYS, HANDOVER_TYPES } from './checkpoint.constants';
import { CheckpointPdfService } from './checkpoint-pdf.service';
import { CompleteCheckpointDto } from './dto/complete-checkpoint.dto';
import { CreateCheckpointDto } from './dto/create-checkpoint.dto';
import { PresignCheckpointMediaDto } from './dto/presign-checkpoint-media.dto';
import { UpdateCheckpointDto } from './dto/update-checkpoint.dto';
import { UpdateCheckpointPointDto } from './dto/update-checkpoint-point.dto';
import { PortalCheckpointsService } from './portal-checkpoints.service';
import { PortalOrdersService } from './portal-orders.service';
import { requirePartner } from './portal.util';

@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/checkpoints')
export class PortalCheckpointsController {
  constructor(
    private readonly checkpoints: PortalCheckpointsService,
    private readonly pdf: CheckpointPdfService,
    private readonly orders: PortalOrdersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List own handover checkpoints (paginated, filterable)' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, example: 50 })
  @ApiQuery({ name: 'plate', required: false })
  @ApiQuery({ name: 'handoverType', required: false, enum: HANDOVER_TYPES })
  @ApiQuery({ name: 'status', required: false, enum: ['draft', 'completed'] })
  @ApiQuery({ name: 'month', required: false, example: 7 })
  @ApiQuery({ name: 'year', required: false, example: 2026 })
  list(
    @CurrentUser() user: SessionUser,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
    @Query('plate') plate?: string,
    @Query('handoverType') handoverType?: string,
    @Query('status') status?: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    const { page, pageSize } = parsePagination(pageRaw, pageSizeRaw);
    return this.checkpoints.list(requirePartner(user), {
      page,
      pageSize,
      plate,
      handoverType,
      status,
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a draft checkpoint (plate must be registered)' })
  create(@CurrentUser() user: SessionUser, @Body() dto: CreateCheckpointDto) {
    return this.checkpoints.create(requirePartner(user), user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One own checkpoint: header, points, media, signatures' })
  detail(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.checkpoints.detail(requirePartner(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update draft checkpoint header fields' })
  update(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCheckpointDto,
  ) {
    return this.checkpoints.update(requirePartner(user), id, dto);
  }

  @Patch(':id/points/:pointKey')
  @ApiOperation({ summary: 'Update one inspection point (passed / note)' })
  @ApiParam({ name: 'pointKey', enum: CHECKPOINT_POINT_KEYS })
  updatePoint(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('pointKey') pointKey: string,
    @Body() dto: UpdateCheckpointPointDto,
  ) {
    return this.checkpoints.updatePoint(requirePartner(user), id, pointKey, dto);
  }

  @Post(':id/media/presign')
  @ApiOperation({
    summary: 'Create a pending media row and get an upload URL (S3 presigned PUT in prod)',
  })
  presign(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PresignCheckpointMediaDto,
  ) {
    return this.checkpoints.presignMedia(requirePartner(user), id, dto);
  }

  @Post(':id/media/:mediaId/confirm')
  @ApiOperation({ summary: 'Confirm an upload finished (marks media uploaded)' })
  confirm(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    return this.checkpoints.confirmMedia(requirePartner(user), id, mediaId);
  }

  @Delete(':id/media/:mediaId')
  @ApiOperation({ summary: 'Delete one media item from a draft checkpoint' })
  deleteMedia(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ) {
    return this.checkpoints.deleteMedia(requirePartner(user), id, mediaId);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Complete the checkpoint (validates points, photos, signatures)' })
  complete(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompleteCheckpointDto,
  ) {
    return this.checkpoints.complete(requirePartner(user), id, dto);
  }

  @Get(':id/comparison')
  @ApiOperation({
    summary: 'Latest completed paired delivery checkpoint for comparison (null when n/a)',
  })
  comparison(@CurrentUser() user: SessionUser, @Param('id', ParseIntPipe) id: number) {
    return this.checkpoints.comparison(requirePartner(user), id);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Berita acara serah terima as PDF (completed checkpoints only)' })
  async exportPdf(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<StreamableFile> {
    const partnerId = requirePartner(user);
    const { detail, buffers } = await this.checkpoints.detailWithBuffers(partnerId, id);
    if (detail.status !== 'completed') {
      throw new ConflictException('Checkpoint belum diselesaikan');
    }
    const partner = await this.orders.partnerProfile(partnerId);
    const buffer = await this.pdf.toPdf(partner.name, detail, buffers);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="berita-acara-checkpoint-${id}.pdf"`,
    });
  }
}
