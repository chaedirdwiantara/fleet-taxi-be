import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { DriverDocumentsService } from './driver-documents.service';
import { DriverSyncService } from './driver-sync.service';
import { PartnerDriversService } from './partner-drivers.service';
import { PortalDriverDocumentsController } from './portal-driver-documents.controller';
import { PortalDriversController } from './portal-drivers.controller';

/** Partner-portal drivers: roster synced from fleet imports + manual completeness edits. */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [
    // documents before drivers: /drivers/documents/... must not match /drivers/:id
    PortalDriverDocumentsController,
    PortalDriversController,
  ],
  providers: [PartnerDriversService, DriverSyncService, DriverDocumentsService],
})
export class PartnerDriversModule {}
