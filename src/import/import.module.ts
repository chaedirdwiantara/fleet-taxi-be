import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { ImportController } from './import.controller';
import { ImportProcessor } from './import.processor';
import { ImportService } from './import.service';
import { IMPORT_QUEUE } from './import.types';

@Module({
  imports: [
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
    StorageModule,
    RealtimeModule,
    UsersModule, // AbilityFactory for PoliciesGuard
  ],
  controllers: [ImportController],
  providers: [ImportService, ImportProcessor],
})
export class ImportModule {}
