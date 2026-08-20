/**
 * One place that turns rows into a downloadable CSV, so every export in the app quotes, escapes
 * and downloads the same way.
 *
 * Two screens had each inlined their own `rows.map(r => '"' + ... + '"').join(',')`, which is how
 * a value containing a comma or a quote ends up splitting a column or breaking a cell in whichever
 * export forgot to escape it. A finance bank file is the worst place for that to happen, so the
 * escaping lives here and is used by name.
 */

/** A single cell: rendered as text, with null/undefined becoming an empty cell (not "null"). */
export type CsvCell = string | number | null | undefined;

/**
 * Escape one cell for CSV. Always quoted — simpler and safe — with embedded quotes doubled.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet does not read the
 * cell as a formula. That CSV-injection guard matters here because these files carry bank
 * references and names that a spreadsheet would otherwise try to evaluate.
 */
function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Header row + data rows to a CSV string, CRLF line endings (what Excel and bank portals expect). */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))];
  return lines.join('\r\n');
}

/**
 * Build the CSV and hand it to the browser as a download.
 *
 * A UTF-8 BOM is prepended so Excel opens Indian names and the ₹ sign in the right encoding
 * instead of mojibake. The object URL is revoked after the click so a long-lived tab does not leak
 * one per export.
 */
export function downloadCsv(filename: string, headers: string[], rows: CsvCell[][]): void {
  const csv = `﻿${toCsv(headers, rows)}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `things_2026-08-20` — a filename stem with today's local date, the app's export convention. */
export function datedFilename(stem: string): string {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${stem}_${key}`;
}
