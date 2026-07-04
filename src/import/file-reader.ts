import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { Readable } from 'node:stream';
import { RawRow } from './parsers/parser.types';

export type SpreadsheetKind = 'csv' | 'xlsx';

export function detectKind(filename: string): SpreadsheetKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null; // .xls (BIFF) is not supported by ExcelJS streaming — reject at upload
}

/** ExcelJS cells can be rich text / formula objects; flatten to primitives. */
function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
    if (o.result !== undefined) return cellValue(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.text !== undefined) return o.text;
    return null; // unknown cell object (error cells etc.) — treat as empty
  }
  return v;
}

/**
 * Streams spreadsheet rows in order. XLSX uses the ExcelJS streaming reader
 * (all sheets, sequentially — Grab files are multi-sheet); CSV uses Papaparse.
 */
export async function* readSpreadsheetRows(
  buffer: Buffer,
  kind: SpreadsheetKind,
): AsyncGenerator<RawRow> {
  if (kind === 'csv') {
    const result = Papa.parse<string[]>(buffer.toString('utf8'), {
      skipEmptyLines: false,
    });
    for (const row of result.data) yield row;
    return;
  }

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), {
    entries: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    worksheets: 'emit',
  });
  for await (const worksheet of reader) {
    for await (const row of worksheet) {
      const values = (row.values ?? []) as unknown[];
      yield values.slice(1).map(cellValue); // ExcelJS row.values is 1-based
    }
  }
}
