import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ImportModule } from '../import/import.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { AdminGojekPortalSyncController } from './admin-gojek-portal-sync.controller';
import { CredentialCipher } from './credential-cipher';
import { GojekFleetPartnerClient } from './gojek-fleet-partner.client';
import { GojekPortalSyncProcessor } from './gojek-portal-sync.processor';
import { GojekPortalSyncService } from './gojek-portal-sync.service';
import { GOJEK_PORTAL_SYNC_QUEUE } from './gojek-portal-sync.types';

@Module({
  imports: [
    BullModule.registerQueue({ name: GOJEK_PORTAL_SYNC_QUEUE }),
    ImportModule, // hands downloads to the same parse pipeline as manual uploads
    StorageModule,
    ActivityLogModule, // failure notifications for super_admins
    UsersModule, // AbilityFactory for PoliciesGuard
  ],
  controllers: [AdminGojekPortalSyncController],
  providers: [
    GojekPortalSyncService,
    GojekPortalSyncProcessor,
    CredentialCipher,
    // Built explicitly (no DI args) so the client always carries the live
    // portal base URL — the evista port once got an "empty" HTTP client from
    // the container and sent `auth/login` to a host literally named `auth`.
    { provide: GojekFleetPartnerClient, useFactory: () => new GojekFleetPartnerClient() },
  ],
})
export class GojekPortalSyncModule {}
