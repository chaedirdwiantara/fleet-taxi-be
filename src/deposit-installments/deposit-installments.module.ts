import { Module } from '@nestjs/common';
import { PartnerPortalModule } from '../partner-portal/partner-portal.module';
import { DepositInstallmentsController } from './deposit-installments.controller';
import { DepositInstallmentsService } from './deposit-installments.service';

/** Cicilan Deposit (partner portal) — legacy Evista Income Cuts port. */
@Module({
  imports: [PartnerPortalModule], // provides PortalPlatesService (plate allowlist scoping)
  controllers: [DepositInstallmentsController],
  providers: [DepositInstallmentsService],
})
export class DepositInstallmentsModule {}
