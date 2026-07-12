import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { GrabModule } from '../grab/grab.module';
import { StorageModule } from '../storage/storage.module';
import { CheckpointPdfService } from './checkpoint-pdf.service';
import { PortalExportService } from './export.service';
import { PortalController } from './portal.controller';
import { PortalCheckpointMediaController } from './portal-checkpoint-media.controller';
import { PortalCheckpointsController } from './portal-checkpoints.controller';
import { PortalCheckpointsService } from './portal-checkpoints.service';
import { PortalFleetController } from './portal-fleet.controller';
import { PortalFleetService } from './portal-fleet.service';
import { PortalOrdersService } from './portal-orders.service';
import { PortalPlatesController } from './portal-plates.controller';
import { PortalPlatesService } from './portal-plates.service';

@Module({
  imports: [AuthModule, FleetModule, GrabModule, StorageModule],
  controllers: [
    PortalController,
    PortalPlatesController,
    PortalFleetController,
    PortalCheckpointsController,
    PortalCheckpointMediaController,
  ],
  providers: [
    PortalOrdersService,
    PortalExportService,
    PortalPlatesService,
    PortalFleetService,
    PortalCheckpointsService,
    CheckpointPdfService,
  ],
})
export class PartnerPortalModule {}
