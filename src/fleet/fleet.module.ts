import { Module } from '@nestjs/common';
import { PartnersModule } from '../partners/partners.module';
import { UsersModule } from '../users/users.module';
import { AdminFleetService } from './admin-fleet.service';
import { DetailsService } from './details.service';
import { ExceptionsService } from './exceptions.service';
import { GojekController } from './gojek.controller';
import { GojekGridService } from './gojek-grid.service';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';

@Module({
  imports: [UsersModule, PartnersModule],
  controllers: [GojekController, TargetsController],
  providers: [
    GojekGridService,
    AdminFleetService,
    ExceptionsService,
    TargetsService,
    DetailsService,
  ],
  exports: [GojekGridService, ExceptionsService],
})
export class FleetModule {}
