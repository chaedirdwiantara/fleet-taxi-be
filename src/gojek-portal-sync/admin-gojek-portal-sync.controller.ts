import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionUser } from '../auth/session.types';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import {
  CreateGojekPortalSyncRunDto,
  ListGojekPortalSyncRunsQueryDto,
  TestGojekPortalConnectionDto,
  UpdateGojekPortalSyncSettingsDto,
} from './dto/gojek-portal-sync.dto';
import { GojekPortalSyncService } from './gojek-portal-sync.service';

/**
 * Gojek Fleet Partner Portal sync — super_admin only. `GojekPortalSync` is
 * granted solely by super_admin's `manage all`, so plain admins get FORBIDDEN
 * from PoliciesGuard regardless of what the console shows.
 */
@ApiTags('admin-gojek-portal-sync')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@CheckPolicies((a) => a.can('manage', 'GojekPortalSync'))
@Controller('admin/gojek-portal-sync')
export class AdminGojekPortalSyncController {
  constructor(private readonly service: GojekPortalSyncService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Portal account (never the password) + daily schedule' })
  getSettings() {
    return this.service.getSettings();
  }

  @Put('settings')
  @ApiOperation({ summary: 'Save portal account + schedule (empty password keeps the stored one)' })
  updateSettings(@Body() dto: UpdateGojekPortalSyncSettingsDto, @CurrentUser() user: SessionUser) {
    return this.service.saveSettings(dto, user.id);
  }

  @Post('test-connection')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login to the portal only; remembers lastVerifiedAt for the stored account',
  })
  testConnection(@Body() dto: TestGojekPortalConnectionDto) {
    return this.service.testConnection(dto);
  }

  @Get('status')
  @ApiOperation({ summary: 'Schedule state, last/current run, next scheduled tick' })
  getStatus() {
    return this.service.getStatus();
  }

  @Get('runs')
  @ApiOperation({ summary: 'Sync run history (newest first)' })
  listRuns(@Query() query: ListGojekPortalSyncRunsQueryDto) {
    return this.service.listRuns(parsePagination(query.page, query.pageSize ?? 20));
  }

  @Post('runs')
  @HttpCode(202)
  @ApiOperation({ summary: 'Run now (queued): optional WIB range, max 31 days' })
  createRun(@Body() dto: CreateGojekPortalSyncRunDto, @CurrentUser() user: SessionUser) {
    return this.service.requestRun(user.id, dto);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'One sync run (poll while status = running)' })
  getRun(@Param('id', ParseIntPipe) id: number) {
    return this.service.getRun(id);
  }
}
