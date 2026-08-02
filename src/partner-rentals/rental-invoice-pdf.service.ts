import { Injectable } from '@nestjs/common';
import { createElement as h } from 'react';
import { RentalInvoiceDto } from './rental-invoice';

/**
 * Renders a `RentalInvoiceDto` as an A4 invoice PDF.
 *
 * Presentation only — every amount arrives pre-computed from
 * `rental-invoice.ts`. Colours mirror the FE design system (brand red
 * #C8102E = `--brand`, slate neutrals) so the document reads as the same
 * product as the dashboard.
 */

const BRAND = '#c8102e';
const INK = '#0f172a'; // slate-900
const MUTED = '#64748b'; // slate-500
const LINE = '#e2e8f0'; // slate-200
const SURFACE = '#f8fafc'; // slate-50
const ZEBRA = '#fbfcfd';
const PAID = '#047857'; // emerald-700
const PAID_BG = '#ecfdf5'; // emerald-50

const PAGE_X = 40;

const DATE_FMT = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const DATETIME_FMT = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  dateStyle: 'long',
  timeStyle: 'short',
});
const RUPIAH_FMT = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });

/** 1234567 → "Rp 1.234.567" (integer rupiah, never cents). */
function rupiah(amount: number): string {
  return `Rp ${RUPIAH_FMT.format(amount)}`;
}

/** 1100 → "11%", 1050 → "10,5%" (basis points, id-ID decimal comma). */
function formatRate(rateBps: number): string {
  return `${(rateBps / 100).toLocaleString('id-ID', { maximumFractionDigits: 2 })}%`;
}

/** 'YYYY-MM-DD' → "2 Agustus 2026". Parsed as UTC noon so the WIB day is exact. */
function formatDate(isoDate: string): string {
  return DATE_FMT.format(new Date(`${isoDate}T12:00:00Z`));
}

/** ISO instant → "2 Agustus 2026", the WIB calendar day it fell on. */
function formatInstantDate(iso: string): string {
  return DATE_FMT.format(new Date(iso));
}

function formatDateTime(iso: string): string {
  return `${DATETIME_FMT.format(new Date(iso))} WIB`;
}

@Injectable()
export class RentalInvoicePdfService {
  async toPdf(invoice: RentalInvoiceDto): Promise<Buffer> {
    // Imported lazily: @react-pdf/renderer is ESM-heavy and only needed here
    const { Document, Page, Text, View, renderToBuffer } = await import('@react-pdf/renderer');

    const text = (
      content: string,
      style: Record<string, unknown> = {},
      key?: string,
    ): ReturnType<typeof h> =>
      h(Text, { key, style: { fontSize: 9, color: INK, ...style } }, content);

    /** Label above value — the atom every info block is built from. */
    const field = (label: string, value: string, key?: string) =>
      h(
        View,
        { key, style: { marginBottom: 6 } },
        text(label.toUpperCase(), { fontSize: 7, color: MUTED, letterSpacing: 0.6 }),
        text(value, { fontSize: 10, marginTop: 2 }),
      );

    const infoCard = (title: string, children: Array<ReturnType<typeof h> | null>) =>
      h(
        View,
        {
          style: {
            flex: 1,
            backgroundColor: SURFACE,
            borderRadius: 6,
            borderLeft: 2,
            borderColor: BRAND,
            padding: 12,
          },
        },
        text(title.toUpperCase(), {
          fontSize: 7,
          fontWeight: 700,
          color: BRAND,
          letterSpacing: 0.8,
          marginBottom: 8,
        }),
        ...children,
      );

    // ---- header --------------------------------------------------------------

    const isPaid = invoice.payment.status === 'Sudah Dibayar';
    const statusPill = h(
      View,
      {
        style: {
          alignSelf: 'flex-end',
          marginTop: 8,
          paddingVertical: 3,
          paddingHorizontal: 8,
          borderRadius: 10,
          backgroundColor: isPaid ? PAID_BG : SURFACE,
        },
      },
      text(isPaid ? 'LUNAS' : 'BELUM DIBAYAR', {
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: 0.8,
        color: isPaid ? PAID : MUTED,
      }),
    );

    const header = h(
      View,
      { style: { flexDirection: 'row', alignItems: 'flex-start' } },
      // The PARTNER is the seller here — the party rendering the service, and
      // the one collecting PPN if it is a PKP. Fleet Taxi only issues the
      // document, so it appears as a subordinate "powered by" line: prominence
      // must not suggest the platform is a party to the transaction.
      h(
        View,
        { style: { flex: 1, paddingRight: 16 } },
        text(invoice.issuer.name, { fontSize: 17, fontWeight: 700 }),
        invoice.issuer.npwp
          ? text(`NPWP ${invoice.issuer.npwp}`, { fontSize: 8.5, color: MUTED, marginTop: 3 })
          : null,
        h(
          Text,
          { style: { fontSize: 7, color: MUTED, marginTop: invoice.issuer.npwp ? 6 : 5 } },
          'Powered by ',
          h(Text, { style: { color: BRAND, fontWeight: 700 } }, 'Fleet Taxi'),
        ),
      ),
      h(
        View,
        { style: { alignItems: 'flex-end' } },
        text('INVOICE', { fontSize: 22, fontWeight: 700, letterSpacing: 2 }),
        statusPill,
      ),
    );

    // ---- parties + rental detail ---------------------------------------------

    const { rental } = invoice;
    const period = `${formatDate(rental.startDate)} – ${formatDate(rental.endDate)}`;
    const unit = [rental.plateNumber, rental.vehicleType].filter(Boolean).join(' · ');
    const area = [rental.serviceArea, rental.region].filter(Boolean).join(' · ');

    const parties = h(
      View,
      { style: { flexDirection: 'row', gap: 12, marginTop: 24 } },
      infoCard('Ditagihkan kepada', [
        field('Nama', invoice.customer.name, 'name'),
        invoice.customer.phone ? field('Telepon', invoice.customer.phone, 'phone') : null,
        field('Nomor Invoice', invoice.invoiceNumber, 'number'),
        field('Tanggal Invoice', formatInstantDate(invoice.issuedAt), 'issued'),
      ]),
      infoCard('Detail sewa', [
        field('Unit', unit, 'unit'),
        field('Periode', `${period} (${rental.days} hari)`, 'period'),
        rental.rentalType ? field('Jenis Sewa', rental.rentalType, 'type') : null,
        area ? field('Area Layanan', area, 'area') : null,
      ]),
    );

    // ---- line items ----------------------------------------------------------

    const COLS = { desc: 4, qty: 1.1, price: 1.7, amount: 1.7 } as const;

    const tableHeader = h(
      View,
      {
        style: {
          flexDirection: 'row',
          backgroundColor: INK,
          borderTopLeftRadius: 4,
          borderTopRightRadius: 4,
          paddingVertical: 7,
          paddingHorizontal: 10,
        },
      },
      text('DESKRIPSI', { flex: COLS.desc, fontSize: 7.5, color: '#ffffff', letterSpacing: 0.6 }),
      text('QTY', {
        flex: COLS.qty,
        fontSize: 7.5,
        color: '#ffffff',
        letterSpacing: 0.6,
        textAlign: 'right',
      }),
      text('HARGA SATUAN', {
        flex: COLS.price,
        fontSize: 7.5,
        color: '#ffffff',
        letterSpacing: 0.6,
        textAlign: 'right',
      }),
      text('JUMLAH', {
        flex: COLS.amount,
        fontSize: 7.5,
        color: '#ffffff',
        letterSpacing: 0.6,
        textAlign: 'right',
      }),
    );

    const rows = invoice.lines.map((line, i) =>
      h(
        View,
        {
          key: String(i),
          wrap: false,
          style: {
            flexDirection: 'row',
            alignItems: 'flex-start',
            paddingVertical: 8,
            paddingHorizontal: 10,
            borderBottom: 0.5,
            borderColor: LINE,
            backgroundColor: i % 2 === 1 ? ZEBRA : '#ffffff',
          },
        },
        h(
          View,
          { style: { flex: COLS.desc } },
          text(line.description, { fontSize: 9.5 }),
          line.detail ? text(line.detail, { fontSize: 8, color: MUTED, marginTop: 2 }) : null,
        ),
        text(`${line.quantity} ${line.unit}`, {
          flex: COLS.qty,
          fontSize: 9.5,
          textAlign: 'right',
        }),
        text(rupiah(line.unitPrice), { flex: COLS.price, fontSize: 9.5, textAlign: 'right' }),
        text(rupiah(line.amount), {
          flex: COLS.amount,
          fontSize: 9.5,
          textAlign: 'right',
          fontWeight: 700,
        }),
      ),
    );

    const table = h(View, { style: { marginTop: 20 } }, tableHeader, ...rows);

    // ---- totals --------------------------------------------------------------

    const totalRow = (label: string, value: string, emphasis = false) =>
      h(
        View,
        {
          style: {
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingVertical: emphasis ? 8 : 5,
            paddingHorizontal: 10,
            ...(emphasis
              ? { backgroundColor: BRAND, borderRadius: 4, marginTop: 4 }
              : { borderBottom: 0.5, borderColor: LINE }),
          },
        },
        text(label, {
          fontSize: emphasis ? 10 : 9,
          fontWeight: 700,
          color: emphasis ? '#ffffff' : MUTED,
        }),
        text(value, {
          fontSize: emphasis ? 13 : 9.5,
          fontWeight: 700,
          color: emphasis ? '#ffffff' : INK,
        }),
      );

    const totals = h(
      View,
      { style: { flexDirection: 'row', marginTop: 14 } },
      h(
        View,
        { style: { flex: 1, paddingRight: 16 } },
        h(
          View,
          {
            style: {
              backgroundColor: SURFACE,
              borderRadius: 4,
              padding: 10,
            },
          },
          text('TERBILANG', { fontSize: 7, color: MUTED, letterSpacing: 0.6 }),
          text(`# ${invoice.amountInWords} #`, {
            fontSize: 9,
            fontStyle: 'italic',
            marginTop: 3,
          }),
        ),
        invoice.deposit > 0
          ? text(
              `Deposit jaminan sebesar ${rupiah(invoice.deposit)} dititipkan terpisah dan tidak mengurangi tagihan ini.`,
              { fontSize: 7.5, color: MUTED, marginTop: 8, lineHeight: 1.4 },
            )
          : null,
      ),
      h(
        View,
        { style: { width: 220 } },
        totalRow(invoice.ppnAmount > 0 ? 'DPP' : 'Subtotal', rupiah(invoice.subtotal)),
        invoice.ppnAmount > 0
          ? totalRow(`PPN ${formatRate(invoice.ppnRateBps)}`, rupiah(invoice.ppnAmount))
          : null,
        totalRow('Total Tagihan', rupiah(invoice.total), true),
      ),
    );

    // ---- payment + signature -------------------------------------------------

    const settled = invoice.payment.settledAt;
    const footerBlocks = h(
      View,
      { wrap: false, style: { flexDirection: 'row', gap: 12, marginTop: 26 } },
      h(
        View,
        {
          style: {
            flex: 1,
            borderRadius: 6,
            padding: 12,
            backgroundColor: isPaid ? PAID_BG : SURFACE,
          },
        },
        text('INFORMASI PEMBAYARAN', {
          fontSize: 7,
          fontWeight: 700,
          letterSpacing: 0.8,
          color: isPaid ? PAID : MUTED,
          marginBottom: 6,
        }),
        text(
          isPaid
            ? 'Tagihan ini telah dibayar lunas. Terima kasih atas kepercayaan Anda.'
            : 'Tagihan ini belum dilunasi. Mohon selesaikan pembayaran sesuai kesepakatan.',
          { fontSize: 8.5, lineHeight: 1.4 },
        ),
        settled
          ? text(`Dibayar pada ${formatDateTime(settled)}`, {
              fontSize: 8,
              color: MUTED,
              marginTop: 5,
            })
          : null,
        invoice.payment.proofCount > 0
          ? text(`${invoice.payment.proofCount} bukti pembayaran terarsip.`, {
              fontSize: 8,
              color: MUTED,
              marginTop: 2,
            })
          : null,
      ),
      h(
        View,
        { style: { width: 180, alignItems: 'center' } },
        text('Hormat kami,', { fontSize: 8.5, color: MUTED }),
        h(View, { style: { height: 46 } }),
        h(View, { style: { width: 150, borderBottom: 0.5, borderColor: LINE } }),
        text(invoice.issuer.name, { fontSize: 9, fontWeight: 700, marginTop: 4 }),
      ),
    );

    const pageFooter = h(
      View,
      {
        fixed: true,
        style: {
          position: 'absolute',
          bottom: 24,
          left: PAGE_X,
          right: PAGE_X,
          flexDirection: 'row',
          justifyContent: 'space-between',
          borderTop: 0.5,
          borderColor: LINE,
          paddingTop: 6,
        },
      },
      text(
        // The platform is already credited in the header; naming it again here
        // would push a vendor mention onto a document the partner issues.
        `Dokumen ini diterbitkan oleh ${invoice.issuer.name}, dibuat otomatis dan sah tanpa tanda tangan basah.`,
        {
          fontSize: 7,
          color: MUTED,
        },
      ),
      h(Text, {
        style: { fontSize: 7, color: MUTED },
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `Hal. ${pageNumber}/${totalPages}`,
      }),
    );

    const doc = h(
      Document,
      {
        title: `Invoice ${invoice.invoiceNumber}`,
        author: invoice.issuer.name,
        subject: `Sewa kendaraan ${rental.plateNumber}`,
        creator: 'Fleet Taxi Dashboard',
      },
      h(
        Page,
        {
          size: 'A4',
          style: { paddingTop: 0, paddingBottom: 56, paddingHorizontal: 0, fontSize: 9 },
        },
        h(View, { fixed: true, style: { height: 5, backgroundColor: BRAND } }),
        h(
          View,
          { style: { paddingHorizontal: PAGE_X, paddingTop: 28 } },
          header,
          parties,
          table,
          totals,
          footerBlocks,
        ),
        pageFooter,
      ),
    );

    return Buffer.from(await renderToBuffer(doc));
  }
}
