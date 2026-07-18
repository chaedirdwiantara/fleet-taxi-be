import { Module } from '@nestjs/common';
import { PartnerRentalsController } from './partner-rentals.controller';
import { PartnerRentalsService } from './partner-rentals.service';
import { RentalCogsDefaultsService } from './rental-cogs-defaults.service';
import { RentalsExportService } from './rentals-export.service';

/** Rental Monitoring (partner portal) — legacy admin/jadwal-mobil-cogs port. */
@Module({
  controllers: [PartnerRentalsController],
  providers: [PartnerRentalsService, RentalCogsDefaultsService, RentalsExportService],
})
export class PartnerRentalsModule {}
