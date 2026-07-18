import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminPartnersController } from './admin-partners.controller';
import { ApiKeysService } from './api-keys.service';
import { PartnersService } from './partners.service';
import { RegisteredPlatesService } from './registered-plates.service';

@Module({
  imports: [UsersModule],
  controllers: [AdminPartnersController],
  providers: [ApiKeysService, PartnersService, RegisteredPlatesService],
  exports: [ApiKeysService, PartnersService, RegisteredPlatesService],
})
export class PartnersModule {}
