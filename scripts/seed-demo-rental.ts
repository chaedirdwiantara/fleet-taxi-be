/**
 * Seeds ONE settled demo rental so the per-transaction invoice shortcut has
 * something to generate from on a fresh environment.
 *
 * Idempotent: the row is tagged `info_source = 'Demo Invoice'` and re-running
 * is a no-op while a tagged row exists for the partner. It writes a real
 * payment-proof object through StorageService (local disk in dev, S3 in prod)
 * so the rental satisfies the "paid ⇒ 1..5 uploaded proofs" rule and the
 * evidence link actually resolves.
 *
 *   PARTNER_CODE=JGS pnpm ts-node -r tsconfig-paths/register scripts/seed-demo-rental.ts
 *
 * PARTNER_CODE is optional when the database holds exactly one partner.
 * Remove the demo later with: DELETE FROM rentals WHERE info_source = 'Demo Invoice';
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { normalizePlate } from '../src/common/util/plate';
import { DatabaseService } from '../src/db/database.service';
import { partners, rentalPaymentProofs, rentals } from '../src/db/schema';
import { currentPeriodWib } from '../src/partner-rentals/rental-presenter';
import { StorageService } from '../src/storage/storage.service';

const DEMO_TAG = 'Demo Invoice';
const DEMO_PLATE = 'B 1234 DEMO';

/** Minimal but structurally valid one-page PDF — stands in for a transfer receipt. */
function demoReceiptPdf(): Buffer {
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.from(body, 'utf8');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { db } = app.get(DatabaseService);
  const storage = app.get(StorageService);

  const code = process.env.PARTNER_CODE?.trim();
  const partnerRows = code
    ? await db.select().from(partners).where(eq(partners.code, code))
    : await db.select().from(partners);
  if (partnerRows.length === 0) {
    throw new Error(code ? `No partner with code ${code}` : 'No partners in this database');
  }
  if (partnerRows.length > 1) {
    throw new Error(
      `Set PARTNER_CODE — this database has ${partnerRows.length} partners, e.g. ${partnerRows
        .slice(0, 10)
        .map((p) => p.code)
        .join(', ')}`,
    );
  }
  const partner = partnerRows[0]!;

  const [existing] = await db
    .select({ id: rentals.id })
    .from(rentals)
    .where(and(eq(rentals.partnerId, partner.id), eq(rentals.infoSource, DEMO_TAG)));
  if (existing) {
    console.log(
      `Demo rental already present for ${partner.code} (id ${existing.id}) — nothing to do.`,
    );
    await app.close();
    return;
  }

  // Anchored to the current WIB month so it lands in the dashboard's default filter.
  const { year, month } = currentPeriodWib();
  const startDate = `${year}-${pad(month)}-05`;
  const endDate = `${year}-${pad(month)}-07`;

  const [rental] = await db
    .insert(rentals)
    .values({
      partnerId: partner.id,
      plateNumber: DEMO_PLATE,
      plateNumberNorm: normalizePlate(DEMO_PLATE),
      vehicleType: 'Wuling Air EV',
      region: 'Jakarta',
      startDate,
      endDate,
      pricePerDay: 350_000,
      cogsPerDay: 150_000,
      cogsType: 'air_ev',
      additionalCost: 275_000,
      additionalCostDescription: 'Tol, parkir & bensin luar kota',
      deposit: 500_000,
      rentalType: 'Dengan Driver',
      infoSource: DEMO_TAG,
      serviceArea: 'Jakarta Selatan',
      customerName: 'Andi Wijaya',
      customerPhone: '0812-3456-7890',
      paymentStatus: 'Sudah Dibayar',
    })
    .returning();

  const receipt = demoReceiptPdf();
  const storageKey = `partner/${partner.id}/rentals/proofs/${randomUUID()}.pdf`;
  await storage.save(storageKey, receipt);
  await db.insert(rentalPaymentProofs).values({
    partnerId: partner.id,
    rentalId: rental!.id,
    storageKey,
    fileName: 'bukti-pembayaran-demo.pdf',
    contentType: 'application/pdf',
    sizeBytes: receipt.length,
    status: 'uploaded',
    uploadedByName: 'Sistem (data demo)',
    uploadedByEmail: 'system@fleet-taxi.id',
  });

  console.log(
    `Demo rental ${rental!.id} (${DEMO_PLATE}, ${startDate}..${endDate}) created for ${partner.code}.`,
  );
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
