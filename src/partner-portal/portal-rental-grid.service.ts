import { Injectable } from '@nestjs/common';
import { PartnerRentalsService } from '../partner-rentals/partner-rentals.service';
import { buildRentalGrid, type RentalGridDto } from '../partner-rentals/rental-grid';
import { PortalPlatesService } from './portal-plates.service';

/**
 * Rental Monitoring's plate × day pivot for the partner portal — the rental
 * sibling of `/fleet/gojek/grid` and `/fleet/grab/grid`.
 *
 * Like {@link PortalAllFleetService} this service computes no money: it fetches
 * the month's bookings through `PartnerRentalsService` (the same query the recap
 * uses) and the partner's registered plates, then hands both to the pure builder.
 * It lives on the portal side rather than in the rentals module because the row
 * set needs the plate registry, and `PartnerPortalModule` already depends on
 * `PartnerRentalsModule` — the reverse would close a cycle.
 *
 * Scoping: bookings by `rentals.partner_id`, plates by the partner's own
 * registry. Both are server-derived; the client never sends a scope.
 */
@Injectable()
export class PortalRentalGridService {
  constructor(
    private readonly rentals: PartnerRentalsService,
    private readonly plates: PortalPlatesService,
  ) {}

  async grid(partnerId: number, month: number, year: number): Promise<RentalGridDto> {
    const [bookings, registered] = await Promise.all([
      this.rentals.monthBookings(partnerId, month, year),
      this.plates.list(partnerId),
    ]);
    return buildRentalGrid(bookings, registered, { month, year });
  }
}
