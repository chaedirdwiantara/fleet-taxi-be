import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminPartnersController } from './admin-partners.controller';
import { ApiKeysService } from './api-keys.service';
import { PartnersService } from './partners.service';

@Module({
  imports: [UsersModule],
  controllers: [AdminPartnersController],
  providers: [ApiKeysService, PartnersService],
  exports: [ApiKeysService, PartnersService],
})
export class PartnersModule {}
