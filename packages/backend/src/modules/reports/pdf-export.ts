// A DEFAULT import of pdfkit compiles here and throws `is not a constructor` at runtime, because
// this project sets allowSyntheticDefaultImports without esModuleInterop and pdfkit is a CommonJS
// `export =` module. A namespace import emits the bare require that actually works — the same form
// `xlsx` is pulled in with next door.
import * as PDFDocument from 'pdfkit';

/**
 * The admin dashboard's PDF export sibling to `excel-export.ts`'s `buildWorkbook` — same idea
 * (tabular rows in, a buffer out), a different renderer. Roster-sized only: this walks every row
 * with pdfkit's synchronous text-layout, so it carries the same "blocks the event loop" caveat
 * `excel-export.ts`'s own comment makes about `xlsx.write` — callers on the slow list should
 * still prefer the queued-job route for a large export, same as the Excel side.
 */

/** Mirrors `EXCEL_MIME` beside it, so callers never spell the type out themselves. */
export const PDF_MIME = 'application/pdf';

const PAGE_MARGIN = 36;
const ROW_HEIGHT = 18;
const HEADER_HEIGHT = 22;
const FONT_SIZE = 8;

export interface TablePdfSpec {
  title: string;
  headers: string[];
  rows: Array<Array<unknown>>;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Shorten a cell so it fits its column on ONE line.
 *
 * pdfkit's own `lineBreak: false` / `ellipsis` options did not hold the line here — the first
 * run of this export wrapped long names and email addresses inside the column and spilled them
 * over the fixed row height into the record below. Measuring and cutting is deterministic, so a
 * row is always exactly one line tall whatever the data.
 */
function fitToWidth(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = '…';
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(cut + ellipsis) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut + ellipsis;
}

export async function buildTablePdf(spec: TablePdfSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE_MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - PAGE_MARGIN * 2;
    const colWidth = pageWidth / Math.max(spec.headers.length, 1);

    const drawHeader = (): number => {
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#1c1f26')
        .text(spec.title, PAGE_MARGIN, PAGE_MARGIN);
      doc.font('Helvetica').fontSize(8).fillColor('#5b6270')
        .text(`Generated ${new Date().toLocaleString('en-IN')}`, PAGE_MARGIN, PAGE_MARGIN + 16);

      const y = PAGE_MARGIN + 36;
      doc.font('Helvetica-Bold').fontSize(FONT_SIZE).fillColor('#ffffff');
      doc.rect(PAGE_MARGIN, y, pageWidth, HEADER_HEIGHT).fill('#29695a');
      doc.fillColor('#ffffff');
      spec.headers.forEach((h, i) => {
        doc.text(fitToWidth(doc, h, colWidth - 8), PAGE_MARGIN + i * colWidth + 4, y + 7, {
          lineBreak: false,
        });
      });
      return y + HEADER_HEIGHT;
    };

    let y = drawHeader();
    const bottomLimit = doc.page.height - PAGE_MARGIN;

    doc.font('Helvetica').fontSize(FONT_SIZE);
    spec.rows.forEach((row, rowIndex) => {
      if (y + ROW_HEIGHT > bottomLimit) {
        doc.addPage();
        y = drawHeader();
        doc.font('Helvetica').fontSize(FONT_SIZE);
      }
      if (rowIndex % 2 === 1) {
        doc.rect(PAGE_MARGIN, y, pageWidth, ROW_HEIGHT).fill('#f4f6f5');
      }
      doc.fillColor('#1c1f26');
      row.forEach((value, i) => {
        doc.text(fitToWidth(doc, cell(value), colWidth - 8), PAGE_MARGIN + i * colWidth + 4, y + 5, {
          lineBreak: false,
        });
      });
      y += ROW_HEIGHT;
    });

    if (spec.rows.length === 0) {
      doc.fillColor('#5b6270').text('No rows to show.', PAGE_MARGIN, y + 8);
    }

    doc.end();
  });
}
