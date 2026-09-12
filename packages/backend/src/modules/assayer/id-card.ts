// `import PDFDocument from 'pdfkit'` compiles here (allowSyntheticDefaultImports is on) but throws
// "pdfkit_1.default is not a constructor" at runtime, because esModuleInterop is OFF in this
// project's tsconfig and pdfkit is a CommonJS `export =` module. A namespace import emits the bare
// require that actually works, and unlike `import x = require()` it is lint-clean.
import * as PDFDocument from 'pdfkit';
import type { Readable } from 'stream';

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The Appraiser Recruitment spec's Module 8: a predefined-template ID card, generated on demand
 * as a PDF. Expiry is always December 31 of the CURRENT calendar year — recomputed fresh on every
 * download, not stored, so a card downloaded in March and one downloaded in November of the same
 * year (or a re-download next year) always states an accurate expiry rather than a stale one.
 */

const CARD_WIDTH = 504; // 7in landscape at 72pt/in — large enough to read the photo and every field
const CARD_HEIGHT = 318; // ~4.4in
const INK = '#1c1f26';
const MUTED = '#5b6270';
const ACCENT = '#29695a';

export interface IdCardInput {
  fullName: string;
  assayerCode: string;
  city?: string | null;
  state?: string | null;
  photograph?: Buffer | null;
  generatedOn: Date;
}

/** December 31 of the SAME year as `reference` — always computed fresh, never stored. */
export function idCardExpiry(reference: Date): Date {
  return new Date(reference.getFullYear(), 11, 31);
}

function formatCardDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export async function buildIdCardPdf(input: IdCardInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [CARD_WIDTH, CARD_HEIGHT], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header band
    doc.rect(0, 0, CARD_WIDTH, 64).fill(ACCENT);
    doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
      .text('SUMERU', 24, 16, { continued: false });
    doc.fontSize(11).font('Helvetica')
      .text('Appraiser Identity Card', 24, 40);

    // Photo
    const photoX = 24;
    const photoY = 88;
    const photoSize = 140;
    doc.roundedRect(photoX, photoY, photoSize, photoSize, 4).lineWidth(1).strokeColor(MUTED).stroke();
    if (input.photograph) {
      try {
        doc.image(input.photograph, photoX + 2, photoY + 2, {
          width: photoSize - 4,
          height: photoSize - 4,
          fit: [photoSize - 4, photoSize - 4],
        });
      } catch {
        // An unreadable image (corrupt file, unsupported format) must not fail the whole card —
        // the border above still marks where a photo belongs.
        doc.fillColor(MUTED).fontSize(9).text('Photo unavailable', photoX + 10, photoY + photoSize / 2 - 5);
      }
    } else {
      doc.fillColor(MUTED).fontSize(9).text('No photo on file', photoX + 10, photoY + photoSize / 2 - 5);
    }

    // Fields, beside the photo
    const fieldX = photoX + photoSize + 28;
    let y = 96;
    const field = (label: string, value: string) => {
      doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(label.toUpperCase(), fieldX, y);
      y += 13;
      doc.fillColor(INK).fontSize(14).font('Helvetica-Bold').text(value, fieldX, y);
      y += 26;
    };

    field('Name', input.fullName);
    field('Appraiser code', input.assayerCode);
    if (input.city || input.state) {
      field('Location', [input.city, input.state].filter(Boolean).join(', '));
    }

    // Issue / expiry, bottom band
    const bandY = CARD_HEIGHT - 56;
    doc.moveTo(24, bandY).lineTo(CARD_WIDTH - 24, bandY).strokeColor('#d8dce1').lineWidth(1).stroke();
    doc.fillColor(MUTED).fontSize(9).font('Helvetica')
      .text(`Issued on ${formatCardDate(input.generatedOn)}`, 24, bandY + 12)
      .text(`Valid until ${formatCardDate(idCardExpiry(input.generatedOn))}`, 24, bandY + 28);

    doc.end();
  });
}
