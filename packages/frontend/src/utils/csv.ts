/**
 * One safe way to put a value in a CSV cell.
 *
 * Two separate problems, both handled here so no export has to remember either:
 *
 * 1. QUOTING — a value containing a comma, quote or newline has to be wrapped in double quotes
 *    with its own quotes doubled, or it breaks the row structure. Every export already did this.
 *
 * 2. FORMULA INJECTION — the one they missed. Excel and Google Sheets treat a cell whose text
 *    begins with `=`, `+`, `-`, `@`, or a tab/carriage-return as a FORMULA when the file is
 *    opened, not as text. So an assayer named `=cmd|'/c calc'!A1`, or a project called
 *    `=HYPERLINK("http://evil","click")`, becomes live code in the spreadsheet of whoever opens
 *    the export — a real path from "someone typed a name into our app" to "code ran on an
 *    auditor's laptop". Quoting does NOT prevent this; the cell is still a formula inside the
 *    quotes. Prefixing a single apostrophe forces the spreadsheet to treat the whole cell as
 *    text. The apostrophe is not shown as data by Excel/Sheets, so a legitimate value that
 *    happens to start with one of these characters still reads correctly.
 */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/** Build a full CSV document from a header row and data rows, every cell run through csvCell. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [
    header.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
  ].join('\n');
}
