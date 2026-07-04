import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { createElement as h } from 'react';
import { orders } from '../db/schema';

type OrderRow = typeof orders.$inferSelect;

const COLUMNS: Array<{ header: string; value: (o: OrderRow) => string | number }> = [
  { header: 'Order Number', value: (o) => o.orderNumber },
  { header: 'Status', value: (o) => o.tripStatus ?? '' },
  { header: 'Pickup', value: (o) => o.pickupCode ?? '' },
  { header: 'Destination', value: (o) => o.destinationCode ?? '' },
  { header: 'Pickup At', value: (o) => (o.pickupAt ? o.pickupAt.toISOString() : '') },
  { header: 'Price (IDR)', value: (o) => o.basicPrice ?? 0 },
  { header: 'Created At', value: (o) => o.createdAt.toISOString() },
];

@Injectable()
export class PortalExportService {
  async ordersToXlsx(partnerName: string, rows: OrderRow[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Orders');
    ws.addRow([`Orders — ${partnerName}`]);
    ws.addRow(COLUMNS.map((c) => c.header)).font = { bold: true };
    for (const o of rows) ws.addRow(COLUMNS.map((c) => c.value(o)));
    ws.columns.forEach((col) => (col.width = 22));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async ordersToPdf(partnerName: string, rows: OrderRow[]): Promise<Buffer> {
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
    const body = rows.map((o, i) =>
      h(
        View,
        { key: String(i), style: { flexDirection: 'row', borderBottom: 0.5 } },
        ...COLUMNS.map((c) => cell(c.value(o))),
      ),
    );

    const doc = h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', orientation: 'landscape', style: { padding: 24 } },
        h(Text, { style: { fontSize: 12, marginBottom: 8 } }, `Orders — ${partnerName}`),
        header,
        ...body,
      ),
    );

    return Buffer.from(await renderToBuffer(doc));
  }
}
