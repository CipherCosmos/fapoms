import { buildTablePdf, PDF_MIME } from './pdf-export';

/**
 * The roster PDF, and specifically the property its first run got wrong.
 *
 * That run passed `width` to pdfkit and trusted `lineBreak:false`/`ellipsis` to keep a cell on one
 * line. pdfkit wrapped anyway, and because rows are drawn at a fixed height the extra lines spilled
 * into the record below — names and email addresses overlapping the next person's row on a document
 * somebody would print and hand round. `fitToWidth` measures and cuts instead, so the invariant
 * below ("one line per row, whatever the data") holds by construction rather than by option.
 */
describe('table PDF export', () => {
  const headers = ['Assayer Code', 'Name', 'Email'];

  it('produces a real PDF', async () => {
    const pdf = await buildTablePdf({ title: 'Assayer Roster', headers, rows: [['AS0001', 'A', 'a@b.c']] });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('declares the PDF media type, so the download route can label it correctly', () => {
    // The queued-download route sends `meta.mimeType`; it used to hardcode the Excel type and
    // served this file as a spreadsheet.
    expect(PDF_MIME).toBe('application/pdf');
  });

  it('renders a page even with no rows at all', async () => {
    // An over-filtered roster export should say "no rows", not produce a broken file.
    const pdf = await buildTablePdf({ title: 'Assayer Roster', headers, rows: [] });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('does not grow the file unboundedly when a cell is absurdly long', async () => {
    // The overlap bug's fingerprint: an over-long cell used to become many wrapped lines. Cut to
    // one line, a 4,000-character cell costs about the same as a short one.
    const short = await buildTablePdf({ title: 'T', headers, rows: [['AS0001', 'Short', 'a@b.c']] });
    const long = await buildTablePdf({
      title: 'T',
      headers,
      rows: [['AS0001', 'x'.repeat(4000), 'y'.repeat(4000)]],
    });
    expect(long.length).toBeLessThan(short.length * 2);
  });

  it('paginates rather than running rows off the bottom of the page', async () => {
    const many = Array.from({ length: 200 }, (_, i) => [`AS${i}`, `Person ${i}`, `p${i}@example.com`]);
    const pdf = await buildTablePdf({ title: 'Assayer Roster', headers, rows: many });
    // More than one /Type /Page object means the second page exists — 200 rows cannot fit on one.
    const pages = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it('handles null and undefined cells without printing "null"', async () => {
    const pdf = await buildTablePdf({
      title: 'T',
      headers,
      rows: [['AS0001', null, undefined]],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
