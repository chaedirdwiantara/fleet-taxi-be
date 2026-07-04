import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PortalExportService } from './export.service';
import { PortalController } from './portal.controller';
import { PortalOrdersService } from './portal-orders.service';

@Module({
  imports: [AuthModule],
  controllers: [PortalController],
  providers: [PortalOrdersService, PortalExportService],
})
export class PartnerPortalModule {}
