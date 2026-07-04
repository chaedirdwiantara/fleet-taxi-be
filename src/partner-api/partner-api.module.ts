import { Module } from '@nestjs/common';
import { PartnersModule } from '../partners/partners.module';
import { PartnerOrdersService } from './partner-orders.service';
import { PricelistService } from './pricelist.service';
import { PartnerOrdersController } from './v1/orders.controller';
import { PricelistController } from './v1/pricelist.controller';

/**
 * External machine-to-machine surface (/partner/v1): API-key auth only,
 * never cookie sessions. Separate module + guards from partner-portal by
 * design (backend-kickoff §3 module rules).
 */
@Module({
  imports: [PartnersModule],
  controllers: [PricelistController, PartnerOrdersController],
  providers: [PricelistService, PartnerOrdersService],
})
export class PartnerApiModule {}
