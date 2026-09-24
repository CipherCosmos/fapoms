/**
 * The one server-side CSV cell encoder. Every CSV the API writes goes through `csvCell`, so the
 * quoting rule and the formula-injection guard live in one place instead of being re-typed (and
 * half-remembered) in each export.
 *
 * Formula injection: a spreadsheet treats a cell that starts with `=`, `+`, `-` or `@` as a
 * formula, and Excel/LibreOffice also accept a leading TAB or CR before one. A name typed as
 * `=HYPERLINK("http://evil","click")` in a roster record would otherwise run in the HR clerk's
 * spreadsheet when they open the export. Such cells are prefixed with an apostrophe, which the
 * spreadsheet shows as text. Quoting alone does NOT help: `"=1+1"` is still evaluated.
 *
 * Numbers are left alone: a genuine negative number (`-5`) is data, not an injection, and it can
 * only reach here as a string if a caller stringified it first.
 */

/** Leading characters a spreadsheet may read as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Characters that force the cell to be quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/** Neutralise a leading formula character without quoting — exported for the guard spec. */
export function neutraliseFormula(s: string): string {
  return FORMULA_LEAD.test(s) ? `'${s}` : s;
}

/** One CSV cell: null/undefined → empty; formula leads neutralised; quoted only when needed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  const s = neutraliseFormula(typeof value === 'string' ? value : String(value));
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (no terminator) from a row of cells. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
