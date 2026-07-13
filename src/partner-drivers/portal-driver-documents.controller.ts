import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiConsumes, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { SessionUser } from '../auth/session.types';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { DriverDocumentsService } from './driver-documents.service';
import { PresignDriverDocumentDto } from './dto/presign-driver-document.dto';
import { requirePartner } from '../partner-portal/portal.util';

/**
 * Driver document uploads (KTP/SIM/SKCK scans, deposit proofs) for any owned
 * driver regardless of lifecycle stage. Presign → PUT → confirm like
 * checkpoint media; the byte endpoints (:documentId/upload|file) are the dev
 * path — prod presigns S3 directly. Registered BEFORE PortalDriversController
 * so /drivers/documents/... never hits the :id route.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/drivers/documents')
export class PortalDriverDocumentsController {
  constructor(private readonly documents: DriverDocumentsService) {}

  @Post(':driverId/presign')
  @ApiOperation({
    summary: 'Create a pending document row and get an upload URL (S3 presigned PUT in prod)',
  })
  presign(
    @CurrentUser() user: SessionUser,
    @Param('driverId', ParseIntPipe) driverId: number,
    @Body() dto: PresignDriverDocumentDto,
  ) {
    return this.documents.presign(requirePartner(user), driverId, dto);
  }

  @Post(':driverId/:documentId/confirm')
  @ApiOperation({
    summary: 'Confirm an upload finished (marks it uploaded, replaces the previous of its kind)',
  })
  confirm(
    @CurrentUser() user: SessionUser,
    @Param('driverId', ParseIntPipe) driverId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documents.confirm(requirePartner(user), driverId, documentId);
  }

  @Delete(':driverId/:documentId')
  @ApiOperation({ summary: 'Delete one driver document' })
  remove(
    @CurrentUser() user: SessionUser,
    @Param('driverId', ParseIntPipe) driverId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.documents.remove(requirePartner(user), driverId, documentId);
  }

  @Put(':documentId/upload')
  @ApiOperation({ summary: 'Upload sink for presigned documents (dev; prod presigns S3)' })
  @ApiConsumes('image/jpeg', 'image/png', 'application/pdf')
  upload(
    @CurrentUser() user: SessionUser,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Req() req: Request,
  ) {
    // Raw body via the route-scoped express.raw() in app.setup.ts
    return this.documents.storeUploaded(
      requirePartner(user),
      documentId,
      req.headers['content-type'],
      req.body as Buffer,
    );
  }

  @Get(':documentId/file')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary: 'Stream one document (dev; prod detail responses carry presigned S3 GET URLs)',
  })
  async file(
    @CurrentUser() user: SessionUser,
    @Param('documentId', ParseIntPipe) documentId: number,
  ): Promise<StreamableFile> {
    const { contentType, body } = await this.documents.file(requirePartner(user), documentId);
    return new StreamableFile(body, { type: contentType });
  }
}
