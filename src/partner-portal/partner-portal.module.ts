import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { GrabModule } from '../grab/grab.module';
import { PartnerRentalsModule } from '../partner-rentals/partner-rentals.module';
import { StorageModule } from '../storage/storage.module';
import { CheckpointPdfService } from './checkpoint-pdf.service';
import { PortalExportService } from './export.service';
import { PortalController } from './portal.controller';
import { PortalCheckpointMediaController } from './portal-checkpoint-media.controller';
import { PortalCheckpointsController } from './portal-checkpoints.controller';
import { PortalCheckpointsService } from './portal-checkpoints.service';
import { PortalAllFleetService } from './portal-all-fleet.service';
import { PortalFleetController } from './portal-fleet.controller';
import { PortalFleetService } from './portal-fleet.service';
import { PortalOrdersService } from './portal-orders.service';
import { PortalPlatesController } from './portal-plates.controller';
import { PortalPlatesService } from './portal-plates.service';

@Module({
  // PartnerRentalsModule: Rental omset is the third source of All Fleet
  // Monitoring, read through PartnerRentalsService so the money rules stay in one
  // place instead of being re-derived here.
  imports: [AuthModule, FleetModule, GrabModule, PartnerRentalsModule, StorageModule],
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
    PortalAllFleetService,
    PortalCheckpointsService,
    CheckpointPdfService,
  ],
  // Plate-allowlist scoping is reused by other partner modules (deposit-installments).
  exports: [PortalPlatesService],
})
export class PartnerPortalModule {}
