import * as xlsx from 'xlsx';

export interface SheetSpec {
  /** Sheet name. Excel caps names at 31 chars and forbids a few characters. */
  name: string;
  /**
   * Header row (column names), in display order. The workbooks the rest of the app reads
   * keep these as plain English column titles rather than internal field names.
   */
  headers: string[];
  /** One array per row, aligned with `headers`. Undefined/null cells are left blank. */
  rows: Array<Array<unknown>>;
}

/** Sanitise a sheet name so Excel accepts it (≤31 chars, no reserved chars). */
function sheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim();
  return cleaned.length > 0 ? cleaned : 'Sheet';
}

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const EXCEL_MIME = XLSX_CONTENT_TYPE;

/**
 * Build an .xlsx buffer from one or more tabular sheets.
 *
 * A sheet with rows builds a real worksheet via `json_to_sheet` (headers on row 1). An
 * empty sheet (no rows) still needs a header row or Excel renders it as a blank sheet, so a
 * row with blank cells is emitted to keep the columns present.
 */
export function buildWorkbook(sheets: SheetSpec[]): Buffer {
  const wb = xlsx.utils.book_new();
  for (const spec of sheets) {
    const data =
      spec.rows.length > 0
        ? [spec.headers, ...spec.rows]
        : [spec.headers, spec.headers.map(() => null)];
    const ws = xlsx.utils.aoa_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, sheetName(spec.name));
  }
  return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** Date helper: render Date objects / ISO strings as the local `YYYY-MM-DD` we use elsewhere. */
export function toDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Currency: render a numeric money value as INR with thousands separators, else blank. */
export function inr(v: unknown): string | null {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return `₹${Number(v).toLocaleString('en-IN')}`;
}