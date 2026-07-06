import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { DetailsService } from './details.service';
import { ExceptionsService } from './exceptions.service';
import { GojekController } from './gojek.controller';
import { GojekGridService } from './gojek-grid.service';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';

@Module({
  imports: [UsersModule],
  controllers: [GojekController, TargetsController],
  providers: [GojekGridService, ExceptionsService, TargetsService, DetailsService],
  exports: [GojekGridService],
})
export class FleetModule {}
