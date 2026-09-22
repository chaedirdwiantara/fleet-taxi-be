import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const partners = pgTable('partners', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  code: text('code').notNull().unique(), // e.g. BHISA, HOTEL_X
  name: text('name').notNull(),
  type: text('type'), // shuttle | hotel | ...
  isActive: boolean('is_active').notNull().default(true),
  /**
   * Pengusaha Kena Pajak. Only a PKP may charge PPN and issue a faktur pajak,
   * so this gates VAT on rental invoices. Defaults FALSE: a partner never
   * starts collecting tax until someone deliberately turns it on.
   */
  isPkp: boolean('is_pkp').notNull().default(false),
  npwp: text('npwp'), // printed on invoices of a PKP partner
  /**
   * Who signs the partner's rental invoices — a named officer and their
   * title ("Head of Rental Operations"). Null falls back to the partner name.
   */
  invoiceSignatoryName: text('invoice_signatory_name'),
  invoiceSignatoryTitle: text('invoice_signatory_title'),
  /** Storage keys of the PNG signature / company stamp embedded on signed invoices. */
  invoiceSignatureKey: text('invoice_signature_key'),
  invoiceStampKey: text('invoice_stamp_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
