import { Injectable, UnprocessableEntityException } from '@nestjs/common';

/**
 * Ported from legacy HelperController::bhinekapricelist + BhisaOrderController.
 * Pool whitelist and prices are the legacy constants; they move to reference
 * tables once the R1 reference data lands.
 */
export const POOL_WHITELIST = ['EVISTA_HALIM', 'BHISA_CAWANG'] as const;
export type PoolCode = (typeof POOL_WHITELIST)[number];

export interface PriceQuote {
  priceListId: string;
  pickupCode: PoolCode;
  destinationCode: PoolCode;
  price: number; // integer rupiah
}

@Injectable()
export class PricelistService {
  assertPool(code: string, field: string): asserts code is PoolCode {
    if (!POOL_WHITELIST.includes(code as PoolCode)) {
      throw new UnprocessableEntityException(`Invalid ${field}`);
    }
  }

  quote(pickupCode: string, destinationCode: string): PriceQuote {
    this.assertPool(pickupCode, 'pickup code');
    this.assertPool(destinationCode, 'destination code');

    // legacy combination check (both directions priced 65 000)
    if (destinationCode === 'EVISTA_HALIM' && pickupCode === 'BHISA_CAWANG') {
      return { priceListId: '1', pickupCode, destinationCode, price: 65000 };
    }
    if (pickupCode === 'EVISTA_HALIM' && destinationCode === 'BHISA_CAWANG') {
      return { priceListId: '2', pickupCode, destinationCode, price: 65000 };
    }
    throw new UnprocessableEntityException('Invalid pickup location and destination combination');
  }

  /** legacy swap-trip rule: destination EVISTA_HALIM marks the order swapped */
  isSwapTrip(destinationCode: string): boolean {
    return destinationCode === 'EVISTA_HALIM';
  }
}
