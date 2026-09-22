import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.service';
import { partners } from '../db/schema';
import { StorageService } from '../storage/storage.service';
import { UpdateInvoiceSettingsDto } from './dto/update-invoice-settings.dto';
import {
  INVOICE_ASSET_CONTENT_TYPE,
  INVOICE_ASSET_MAX_BYTES,
  INVOICE_SIGNATURE_REQUIRED_MESSAGE,
  InvoiceAssetKind,
} from './rental-invoice-settings.constants';

export interface InvoiceSettingsDto {
  signatoryName: string | null;
  signatoryTitle: string | null;
  /** Viewable URL of the uploaded artwork (presigned in prod), null when none. */
  signatureUrl: string | null;
  stampUrl: string | null;
}

/** Artwork embedded on a signed invoice — read from storage at render time. */
export interface InvoiceSigningAssets {
  signature: Buffer;
  stamp: Buffer | null;
}

/** Bytes 0..7 of every PNG file (RFC 2083 §3.1). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PRESIGN_GET_TTL_SEC = 600;

type SettingsRow = {
  invoiceSignatoryName: string | null;
  invoiceSignatoryTitle: string | null;
  invoiceSignatureKey: string | null;
  invoiceStampKey: string | null;
};

/**
 * Per-partner invoice signing: the named signatory and the PNG signature /
 * stamp artwork. Unlike payment proofs, the artwork is uploaded THROUGH the
 * API rather than presigned: it is one small object per partner, replaced a
 * handful of times ever, so the presign → PUT → confirm round-trips and the
 * draft-row bookkeeping would buy nothing. Bytes are validated here (PNG
 * magic, size cap) before they reach storage.
 */
@Injectable()
export class RentalInvoiceSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  async get(partnerId: number): Promise<InvoiceSettingsDto> {
    return this.present(await this.row(partnerId));
  }

  async update(partnerId: number, dto: UpdateInvoiceSettingsDto): Promise<InvoiceSettingsDto> {
    const [row] = await this.database.db
      .update(partners)
      .set({
        invoiceSignatoryName: dto.signatoryName?.trim() || null,
        invoiceSignatoryTitle: dto.signatoryTitle?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partnerId))
      .returning(SETTINGS_COLUMNS);
    if (!row) throw new NotFoundException('Partner tidak ditemukan');
    return this.present(row);
  }

  /** Replaces the signature or stamp artwork with the uploaded PNG bytes. */
  async storeAsset(
    partnerId: number,
    kind: InvoiceAssetKind,
    contentType: string | undefined,
    body: Buffer | undefined,
  ): Promise<InvoiceSettingsDto> {
    if (contentType !== INVOICE_ASSET_CONTENT_TYPE) {
      throw new BadRequestException(`Content-Type harus ${INVOICE_ASSET_CONTENT_TYPE}`);
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Body kosong');
    }
    if (body.length > INVOICE_ASSET_MAX_BYTES) {
      throw new BadRequestException('File terlalu besar (maksimal 2 MB)');
    }
    if (!body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new BadRequestException('File bukan PNG yang valid');
    }

    const previous = await this.row(partnerId);
    const key = `partner/${partnerId}/invoice/${kind}-${randomUUID()}.png`;
    await this.storage.save(key, body);

    const [row] = await this.database.db
      .update(partners)
      .set({ [this.keyField(kind)]: key, updatedAt: new Date() })
      .where(eq(partners.id, partnerId))
      .returning(SETTINGS_COLUMNS);
    if (!row) throw new NotFoundException('Partner tidak ditemukan');

    const oldKey = this.keyOf(previous, kind);
    if (oldKey) await this.storage.delete(oldKey);
    return this.present(row);
  }

  async removeAsset(partnerId: number, kind: InvoiceAssetKind): Promise<InvoiceSettingsDto> {
    const previous = await this.row(partnerId);
    const [row] = await this.database.db
      .update(partners)
      .set({ [this.keyField(kind)]: null, updatedAt: new Date() })
      .where(eq(partners.id, partnerId))
      .returning(SETTINGS_COLUMNS);
    if (!row) throw new NotFoundException('Partner tidak ditemukan');

    const oldKey = this.keyOf(previous, kind);
    if (oldKey) await this.storage.delete(oldKey);
    return this.present(row);
  }

  /** The stored artwork bytes, for the dev file endpoint. */
  async assetFile(
    partnerId: number,
    kind: InvoiceAssetKind,
  ): Promise<{ contentType: string; body: Buffer }> {
    const key = this.keyOf(await this.row(partnerId), kind);
    if (!key) throw new NotFoundException('Gambar belum diunggah');
    return { contentType: INVOICE_ASSET_CONTENT_TYPE, body: await this.storage.read(key) };
  }

  /**
   * Artwork for a signed invoice. A signature is mandatory — a "signed" copy
   * without one would be indistinguishable from the plain one — while the
   * stamp is optional.
   */
  async signingAssets(partnerId: number): Promise<InvoiceSigningAssets> {
    const row = await this.row(partnerId);
    if (!row.invoiceSignatureKey) {
      throw new ConflictException(INVOICE_SIGNATURE_REQUIRED_MESSAGE);
    }
    const [signature, stamp] = await Promise.all([
      this.storage.read(row.invoiceSignatureKey),
      row.invoiceStampKey ? this.storage.read(row.invoiceStampKey) : Promise.resolve(null),
    ]);
    return { signature, stamp };
  }

  // ---- internals -------------------------------------------------------------

  private async row(partnerId: number): Promise<SettingsRow> {
    const [row] = await this.database.db
      .select(SETTINGS_COLUMNS)
      .from(partners)
      .where(eq(partners.id, partnerId));
    if (!row) throw new NotFoundException('Partner tidak ditemukan');
    return row;
  }

  private keyField(kind: InvoiceAssetKind): 'invoiceSignatureKey' | 'invoiceStampKey' {
    return kind === 'signature' ? 'invoiceSignatureKey' : 'invoiceStampKey';
  }

  private keyOf(row: SettingsRow, kind: InvoiceAssetKind): string | null {
    return row[this.keyField(kind)];
  }

  private async present(row: SettingsRow): Promise<InvoiceSettingsDto> {
    return {
      signatoryName: row.invoiceSignatoryName,
      signatoryTitle: row.invoiceSignatoryTitle,
      signatureUrl: await this.viewUrl(row.invoiceSignatureKey, 'signature'),
      stampUrl: await this.viewUrl(row.invoiceStampKey, 'stamp'),
    };
  }

  /**
   * Presigned S3 GET in prod; the API's own file route in dev. The dev URL
   * carries the key's random suffix so a replaced image is never served from
   * the browser's cache of the previous one.
   */
  private async viewUrl(key: string | null, kind: InvoiceAssetKind): Promise<string | null> {
    if (!key) return null;
    if (this.storage.isS3()) return this.storage.presignGet(key, PRESIGN_GET_TTL_SEC);
    const version = key.slice(key.lastIndexOf('-') + 1, key.lastIndexOf('.'));
    return `/partner/portal/rentals/invoice-settings/${kind}/file?v=${version}`;
  }
}

const SETTINGS_COLUMNS = {
  invoiceSignatoryName: partners.invoiceSignatoryName,
  invoiceSignatoryTitle: partners.invoiceSignatoryTitle,
  invoiceSignatureKey: partners.invoiceSignatureKey,
  invoiceStampKey: partners.invoiceStampKey,
};
