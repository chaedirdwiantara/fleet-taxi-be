import {
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
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
import { PortalCheckpointsService } from './portal-checkpoints.service';
import { requirePartner } from './portal.util';

/**
 * Media byte endpoints, split from the main controller because these routes
 * key on :mediaId alone (ownership is checked via the media→checkpoint join).
 * In production the presign flow points clients straight at S3 and these are
 * effectively dev-only; they still enforce the same session + partner scoping.
 */
@ApiTags('partner-portal')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('partner/portal/checkpoints/media')
export class PortalCheckpointMediaController {
  constructor(private readonly checkpoints: PortalCheckpointsService) {}

  @Put(':mediaId/upload')
  @ApiOperation({ summary: 'Upload sink for presigned media (dev; prod presigns S3 directly)' })
  @ApiConsumes('image/jpeg', 'image/png')
  upload(
    @CurrentUser() user: SessionUser,
    @Param('mediaId', ParseIntPipe) mediaId: number,
    @Req() req: Request,
  ) {
    // Raw image body via the route-scoped express.raw() in app.setup.ts
    return this.checkpoints.storeUploadedMedia(
      requirePartner(user),
      mediaId,
      req.headers['content-type'],
      req.body as Buffer,
    );
  }

  @Get(':mediaId/file')
  @Header('Cache-Control', 'private, max-age=300')
  @ApiOperation({
    summary: 'Stream one media file (dev; prod detail responses carry presigned S3 GET URLs)',
  })
  async file(
    @CurrentUser() user: SessionUser,
    @Param('mediaId', ParseIntPipe) mediaId: number,
  ): Promise<StreamableFile> {
    const { contentType, body } = await this.checkpoints.mediaFile(requirePartner(user), mediaId);
    return new StreamableFile(body, { type: contentType });
  }
}
