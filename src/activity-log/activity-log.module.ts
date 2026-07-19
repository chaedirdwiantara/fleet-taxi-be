import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ActivityLogService } from './activity-log.service';
import { AdminActivityLogsController } from './admin-activity-logs.controller';

/**
 * Global so the auth controllers, the partner portal, and the app-wide
 * ActivityLogInterceptor can all inject ActivityLogService without every
 * module importing this one explicitly.
 */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AdminActivityLogsController],
  providers: [ActivityLogService],
  exports: [ActivityLogService],
})
export class ActivityLogModule {}
