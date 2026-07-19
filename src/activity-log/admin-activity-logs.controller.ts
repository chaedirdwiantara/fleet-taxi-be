import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CheckPolicies } from '../common/decorators/check-policies.decorator';
import { PoliciesGuard } from '../common/guards/policies.guard';
import { SessionGuard } from '../common/guards/session.guard';
import { parsePagination } from '../common/util/pagination';
import { ActivityLogService } from './activity-log.service';
import { ListActivityLogsQueryDto } from './dto/list-activity-logs-query.dto';

@ApiTags('admin-activity-logs')
@ApiCookieAuth('session')
@UseGuards(SessionGuard, PoliciesGuard)
@Controller('admin/activity-logs')
export class AdminActivityLogsController {
  constructor(private readonly activityLogService: ActivityLogService) {}

  @Get()
  @CheckPolicies((a) => a.can('read', 'ActivityLog'))
  @ApiOperation({
    summary: 'Activity log of all accounts — admin console + partner portal (super_admin only)',
  })
  list(@Query() query: ListActivityLogsQueryDto) {
    const page = parsePagination(query.page, query.pageSize);
    return this.activityLogService.list(
      {
        audience: query.audience,
        actor: query.actor,
        action: query.action,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        search: query.search,
      },
      page,
    );
  }
}
