import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { DebtRowDto } from './debt-presenter';

const COLUMNS: Array<{ header: string; value: (r: DebtRowDto) => string | number }> = [
  { header: 'Driver', value: (r) => r.driverName },
  { header: 'Cabang', value: (r) => r.cabang },
  { header: 'Koordinator', value: (r) => r.koordinator },
  { header: 'Plat Nomor Terakhir', value: (r) => r.lastPlate },
  { header: 'Status', value: (r) => r.status },
  { header: 'Deposit Terbayar', value: (r) => r.depositTerbayar },
  { header: 'Tagihan Setoran', value: (r) => r.tagihanSetoran },
  { header: 'Tagihan ETLE', value: (r) => r.tagihanEtle },
  { header: 'Tagihan Own Risk', value: (r) => r.tagihanOwnRisk },
  { header: 'Cicilan Lainnya', value: (r) => r.cicilanLainnya ?? '' },
  { header: 'Total Tagihan', value: (r) => r.totalTagihan },
  { header: 'Deposit vs Total Outstanding', value: (r) => r.selisihDeposit },
];

@Injectable()
export class DebtExportService {
  async toXlsx(rows: DebtRowDto[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Debt Summary');
    ws.addRow(COLUMNS.map((c) => c.header)).font = { bold: true };
    for (const r of rows) ws.addRow(COLUMNS.map((c) => c.value(r)));
    ws.columns.forEach((col) => (col.width = 22));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
