import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { GrabModule } from '../grab/grab.module';
import { PortalExportService } from './export.service';
import { PortalController } from './portal.controller';
import { PortalFleetController } from './portal-fleet.controller';
import { PortalFleetService } from './portal-fleet.service';
import { PortalOrdersService } from './portal-orders.service';
import { PortalPlatesController } from './portal-plates.controller';
import { PortalPlatesService } from './portal-plates.service';

@Module({
  imports: [AuthModule, FleetModule, GrabModule],
  controllers: [PortalController, PortalPlatesController, PortalFleetController],
  providers: [PortalOrdersService, PortalExportService, PortalPlatesService, PortalFleetService],
})
export class PartnerPortalModule {}
