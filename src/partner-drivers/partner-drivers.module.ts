import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { DriverDocumentsService } from './driver-documents.service';
import { PartnerDriversService } from './partner-drivers.service';
import { PortalDriverDocumentsController } from './portal-driver-documents.controller';
import { PortalDriverRegistrationsController } from './portal-driver-registrations.controller';
import { PortalDriverResignationsController } from './portal-driver-resignations.controller';
import { PortalDriversController } from './portal-drivers.controller';

/** Partner-portal driver management: registration → active roster → resignation. */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [
    PortalDriverRegistrationsController,
    // documents before drivers: /drivers/documents/... must not match /drivers/:id
    PortalDriverDocumentsController,
    PortalDriversController,
    PortalDriverResignationsController,
  ],
  providers: [PartnerDriversService, DriverDocumentsService],
})
export class PartnerDriversModule {}
