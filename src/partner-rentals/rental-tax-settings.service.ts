import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { partners } from '../db/schema';
import { UpdateTaxSettingsDto } from './dto/update-tax-settings.dto';
import { PPN_RATE_BPS } from './rental-presenter';

export interface TaxSettingsDto {
  isPkp: boolean;
  npwp: string | null;
  /** Rate new rentals will be written with — 0 while the partner is not PKP. */
  ppnRateBps: number;
  /** The statutory rate, so the UI can name it without hardcoding 11%. */
  statutoryRateBps: number;
}

/**
 * Per-partner VAT settings. Changing them never rewrites existing rentals:
 * each row carries the rate it was billed at (see `rentals.ppnRateBps`).
 */
@Injectable()
export class RentalTaxSettingsService {
  constructor(private readonly database: DatabaseService) {}

  async get(partnerId: number): Promise<TaxSettingsDto> {
    const [row] = await this.database.db
      .select({ isPkp: partners.isPkp, npwp: partners.npwp })
      .from(partners)
      .where(eq(partners.id, partnerId));
    if (!row) throw new NotFoundException('Partner tidak ditemukan');
    return this.present(row);
  }

  async update(partnerId: number, dto: UpdateTaxSettingsDto): Promise<TaxSettingsDto> {
    const [row] = await this.database.db
      .update(partners)
      .set({ isPkp: dto.isPkp, npwp: dto.npwp?.trim() || null, updatedAt: new Date() })
      .where(eq(partners.id, partnerId))
      .returning({ isPkp: partners.isPkp, npwp: partners.npwp });
    if (!row) throw new NotFoundException('Partner tidak ditemukan');
    return this.present(row);
  }

  private present(row: { isPkp: boolean; npwp: string | null }): TaxSettingsDto {
    return {
      isPkp: row.isPkp,
      npwp: row.npwp,
      ppnRateBps: row.isPkp ? PPN_RATE_BPS : 0,
      statutoryRateBps: PPN_RATE_BPS,
    };
  }
}
