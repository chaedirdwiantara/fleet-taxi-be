import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { createElement as h } from 'react';
import { RentalItemDto, RentalSummaryDto } from './rental-presenter';

const COLUMNS: Array<{
  header: string;
  value: (r: RentalItemDto, index: number) => string | number;
}> = [
  { header: 'No', value: (_r, i) => i + 1 },
  { header: 'Plat', value: (r) => r.plateNumber },
  { header: 'Tipe', value: (r) => r.vehicleType ?? '' },
  { header: 'Region', value: (r) => r.region ?? '' },
  { header: 'Tanggal', value: (r) => `${r.displayStartDate} s/d ${r.displayEndDate}` },
  { header: 'Durasi (Hari)', value: (r) => r.days },
  { header: 'Harga/Hari', value: (r) => r.pricePerDay },
  { header: 'Customer', value: (r) => r.customerName ?? '' },
  { header: 'Telepon', value: (r) => r.customerPhone ?? '' },
  { header: 'Status Bayar', value: (r) => r.paymentStatus },
  { header: 'Gross', value: (r) => r.gross },
  { header: 'Additional Cost', value: (r) => r.additionalCost },
  { header: 'COGS', value: (r) => r.cogsTotal },
  { header: 'Nett Profit', value: (r) => r.nettProfit },
];

/** 'TOTAL (Paid Only)' footer, aligned to the COLUMNS above. */
function totalRow(summary: RentalSummaryDto): Array<string | number> {
  const row: Array<string | number> = COLUMNS.map(() => '');
  row[0] = 'TOTAL (Paid Only)';
  row[COLUMNS.findIndex((c) => c.header === 'Gross')] = summary.paidGross;
  row[COLUMNS.findIndex((c) => c.header === 'Additional Cost')] = summary.paidAdditionalCost;
  row[COLUMNS.findIndex((c) => c.header === 'COGS')] = summary.paidCogs;
  row[COLUMNS.findIndex((c) => c.header === 'Nett Profit')] = summary.paidNettProfit;
  return row;
}

@Injectable()
export class RentalsExportService {
  async rentalsToXlsx(
    title: string,
    items: RentalItemDto[],
    summary: RentalSummaryDto,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rental Monitoring');
    ws.addRow([title]);
    ws.addRow(COLUMNS.map((c) => c.header)).font = { bold: true };
    items.forEach((r, i) => ws.addRow(COLUMNS.map((c) => c.value(r, i))));
    ws.addRow(totalRow(summary)).font = { bold: true };
    ws.columns.forEach((col) => (col.width = 18));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async rentalsToPdf(
    title: string,
    items: RentalItemDto[],
    summary: RentalSummaryDto,
  ): Promise<Buffer> {
    // Imported lazily: @react-pdf/renderer is ESM-heavy and only needed here
    const { Document, Page, Text, View, renderToBuffer } = await import('@react-pdf/renderer');

    const cell = (text: string | number, flex = 1, bold = false) =>
      h(
        View,
        { style: { flex, padding: 2 } },
        h(Text, { style: { fontSize: 7, fontWeight: bold ? 700 : 400 } }, String(text)),
      );

    const header = h(
      View,
      { style: { flexDirection: 'row', borderBottom: 1, marginBottom: 2 } },
      ...COLUMNS.map((c) => cell(c.header, 1, true)),
    );
    const body = items.map((r, i) =>
      h(
        View,
        { key: String(i), style: { flexDirection: 'row', borderBottom: 0.5 } },
        ...COLUMNS.map((c) => cell(c.value(r, i))),
      ),
    );
    const footer = h(
      View,
      { style: { flexDirection: 'row', borderTop: 1, marginTop: 2 } },
      ...totalRow(summary).map((v) => cell(v, 1, true)),
    );

    const doc = h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', orientation: 'landscape', style: { padding: 24 } },
        h(Text, { style: { fontSize: 12, marginBottom: 8 } }, title),
        header,
        ...body,
        footer,
      ),
    );

    return Buffer.from(await renderToBuffer(doc));
  }
}
