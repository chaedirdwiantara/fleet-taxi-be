import { Module } from '@nestjs/common';
import { PartnerRentalsController } from './partner-rentals.controller';
import { PartnerRentalsService } from './partner-rentals.service';
import { RentalCogsDefaultsService } from './rental-cogs-defaults.service';
import { RentalsExportService } from './rentals-export.service';

/** Rental Monitoring (partner portal) — legacy admin/jadwal-mobil-cogs port. */
@Module({
  controllers: [PartnerRentalsController],
  providers: [PartnerRentalsService, RentalCogsDefaultsService, RentalsExportService],
  // Rental income is one of the three sources of the partner portal's All Fleet
  // Monitoring matrix, so the portal module reads it through this service rather
  // than re-querying `rentals` with its own money rules.
  exports: [PartnerRentalsService],
})
export class PartnerRentalsModule {}
