// `import PDFDocument from 'pdfkit'` compiles here (allowSyntheticDefaultImports is on) but throws
// "pdfkit_1.default is not a constructor" at runtime, because esModuleInterop is OFF in this
// project's tsconfig and pdfkit is a CommonJS `export =` module. A namespace import emits the bare
// require that actually works, and unlike `import x = require()` it is lint-clean.
import * as PDFDocument from 'pdfkit';
import type { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The Appraiser Recruitment spec's Module 8: a modern branded identity credential card,
 * generated on demand as a PDF. Validity is computed fresh on every download, never stored, so a
 * re-download always states an accurate expiry rather than a stale one.
 */

const CARD_WIDTH = 504; // 7in landscape at 72pt/in — standard CR80 ID proportion
const CARD_HEIGHT = 318; // ~4.4in
const COLOR_PRIMARY = '#0f172a'; // Obsidian Navy
const COLOR_ACCENT = '#f97316'; // Sumeru Amber
const COLOR_GOLD = '#d97706'; // Metallic Gold
const COLOR_MUTED = '#64748b'; // Slate Muted
const COLOR_DARK = '#1e293b'; // Charcoal Dark
const COLOR_SUCCESS = '#059669'; // Emerald

/**
 * The role the card names. Bank branches call this person a Gold Appraiser; the HR screens call
 * the same person an assayer. One constant, read by the PDF and by the preview route, so the
 * printed card and the screen cannot name the role two different ways.
 */
export const ID_CARD_JOB_TITLE = 'Gold Appraiser';

/**
 * What the card must NOT claim, and why it no longer does (owner's decision, 2026-09-16).
 *
 * An audit found the card vouching for things nothing had checked: "VERIFIED OFFICER" on everyone,
 * "CERTIFIED", a decorative EMV chip on a card with no chip, one hard-coded division for the whole
 * workforce, and "DIGITAL VERIFICATION: sumeru.global/verify" — a page that does not exist. A bank
 * counter reads a card literally. So the card now prints only what the record or Admin → Settings
 * actually holds, and a line with nothing behind it is left off rather than filled in.
 */
export interface IdCardInput {
  fullName: string;
  assayerCode: string;
  city?: string | null;
  state?: string | null;
  /** HR's department for the person. Unset leaves the DEPARTMENT line off the card. */
  department?: string | null;
  photograph?: Buffer | null;
  generatedOn: Date;
  /** Computed by `idCardValidTill` from the configured validity rule — policy stays out of here. */
  validTill: Date;
  /** Admin → Settings `idCard.signatoryName` / `idCard.signatoryTitle`. Unset prints no name/title. */
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  /** Admin → Settings `idCard.helplinePhone`. Unset leaves the "If found" line off. */
  helplinePhone?: string | null;
  /** Admin → Settings `company.address` — the same address the invoices print. */
  officeAddress?: string | null;
}

/**
 * One printable line, or null when there is nothing to print.
 *
 * Trimmed, and any line breaks folded into ", " — every text slot on the card is one line tall, and
 * an address typed over several lines must not wrap into whatever sits below it.
 */
export function cardLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = value
    .split(/[\r\n]+/)
    .map((part) => part.trim().replace(/,+$/, '').trim())
    .filter(Boolean)
    .join(', ');
  return line ? line : null;
}

/** "City, State" from whichever halves exist; null when neither does. Never an invented place. */
export function idCardLocation(city?: string | null, state?: string | null): string | null {
  const parts = [cardLine(city), cardLine(state)].filter((p): p is string => p !== null);
  return parts.length ? parts.join(', ') : null;
}

/** The issuance judgement, as `RosterRecordsService.idCardTerms` computes it — no side effects. */
export interface IdCardTerms {
  refusals: string[];
  gated: string[];
  gateMode: string;
  issuedOn: Date;
  validTill: Date;
}

/** The card text an administrator controls, already passed through `cardLine`. */
export interface IdCardPrintedText {
  signatoryName: string | null;
  signatoryTitle: string | null;
  helplinePhone: string | null;
  officeAddress: string | null;
}

/**
 * Whether the download route would hand the card over right now — the ONE statement of that
 * condition. `downloadIdCard` refuses on `!canDownload`, and the preview reports the same value, so
 * a screen can never offer a download the route then refuses (or hide one it would allow).
 *
 * `refusals` block in every mode. `gated` items block only under `enforce`; under `warn` they are
 * `gaps` — the card is issued and the gap is written to the audit trail at download time.
 */
export function idCardDownloadVerdict(terms: Pick<IdCardTerms, 'refusals' | 'gated' | 'gateMode'>): {
  canDownload: boolean;
  blockedBecause: string[];
  gaps: string[];
} {
  const enforced = terms.gateMode === 'enforce';
  const canDownload = terms.refusals.length === 0 && !(terms.gated.length > 0 && enforced);
  return {
    canDownload,
    blockedBecause: canDownload ? [] : [...terms.refusals, ...(enforced ? terms.gated : [])],
    gaps: enforced ? [] : [...terms.gated],
  };
}

/** `GET /assayers/:assayerId/id-card/preview` — exactly what the card would print, and whether it may. */
export interface IdCardPreview {
  canDownload: boolean;
  blockedBecause: string[];
  gaps: string[];
  issuedOn: string;
  validTill: string;
  jobTitle: string;
  fullName: string;
  assayerCode: string;
  department: string | null;
  location: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  helplinePhone: string | null;
  officeAddress: string | null;
}

export interface IdCardPerson {
  displayName: string;
  assayerCode: string;
  department?: string | null;
  city?: string | null;
  state?: string | null;
}

/**
 * The card's content, decided once. The preview route returns this; the download route builds the
 * PDF's input from this same object (`idCardPdfInput`), so screen and paper share one code path.
 */
export function idCardPreview(person: IdCardPerson, terms: IdCardTerms, printed: IdCardPrintedText): IdCardPreview {
  return {
    ...idCardDownloadVerdict(terms),
    issuedOn: terms.issuedOn.toISOString(),
    validTill: terms.validTill.toISOString(),
    jobTitle: ID_CARD_JOB_TITLE,
    fullName: person.displayName,
    assayerCode: person.assayerCode,
    department: cardLine(person.department),
    location: idCardLocation(person.city, person.state),
    signatoryName: cardLine(printed.signatoryName),
    signatoryTitle: cardLine(printed.signatoryTitle),
    helplinePhone: cardLine(printed.helplinePhone),
    officeAddress: cardLine(printed.officeAddress),
  };
}

/** The PDF's input, from the preview's own values — nothing on the card is computed a second way. */
export function idCardPdfInput(
  preview: IdCardPreview,
  person: IdCardPerson,
  terms: Pick<IdCardTerms, 'issuedOn' | 'validTill'>,
  photograph: Buffer | null,
): IdCardInput {
  return {
    fullName: preview.fullName,
    assayerCode: preview.assayerCode,
    city: person.city,
    state: person.state,
    department: preview.department,
    photograph,
    generatedOn: terms.issuedOn,
    validTill: terms.validTill,
    signatoryName: preview.signatoryName,
    signatoryTitle: preview.signatoryTitle,
    helplinePhone: preview.helplinePhone,
    officeAddress: preview.officeAddress,
  };
}

function formatCardDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Every piece of text the card prints, decided before anything is drawn.
 *
 * Pure, so what the card says is testable without reading a PDF back: `buildIdCardPdf` draws from
 * this and prints nothing else except the photo placeholder. An absent value yields an absent item,
 * never a stand-in ("Head Office", a default division, a signatory nobody set).
 */
export interface IdCardFace {
  brand: string;
  subtitle: string;
  role: string;
  name: string;
  idLine: string;
  /** Labelled lines beside the photo, in print order; only the ones with a value. */
  fields: Array<{ label: string; value: string }>;
  issued: string;
  validThru: string;
  /** Under the signature rule. `caption` is set only when neither name nor title is. */
  signatory: { name: string | null; title: string | null; caption: string | null };
  /** Small print under the dates; only the lines with a value. */
  footer: string[];
}

export function idCardTextLines(input: IdCardInput): IdCardFace {
  const location = idCardLocation(input.city, input.state);
  const department = cardLine(input.department);
  const signatoryName = cardLine(input.signatoryName);
  const signatoryTitle = cardLine(input.signatoryTitle);
  const helpline = cardLine(input.helplinePhone);
  const address = cardLine(input.officeAddress);

  const fields: IdCardFace['fields'] = [];
  if (location) fields.push({ label: 'LOCATION', value: location });
  if (department) fields.push({ label: 'DEPARTMENT', value: department });

  const footer: string[] = [];
  if (helpline) footer.push(`If found, please call ${helpline}`);
  if (address) footer.push(address);

  return {
    brand: 'SUMERU GLOBAL',
    subtitle: 'FIELD AUDIT OPERATIONS',
    role: ID_CARD_JOB_TITLE.toUpperCase(),
    name: input.fullName,
    idLine: `ID: ${input.assayerCode}`,
    fields,
    issued: `Issued: ${formatCardDate(input.generatedOn)}`,
    validThru: `Valid Thru: ${formatCardDate(input.validTill)}`,
    signatory: {
      name: signatoryName,
      title: signatoryTitle,
      caption: signatoryName || signatoryTitle ? null : 'Authorised signatory',
    },
    footer,
  };
}

/**
 * Shorten text so it fits `maxWidth` on ONE line at the document's current font and size.
 *
 * pdfkit does not honour `lineBreak:false` + `ellipsis` for single-line text in this repo — long
 * text wraps and lands on the line below. Measuring and cutting is deterministic. This is the same
 * measure-and-cut as the private `fitToWidth` in `../reports/pdf-export.ts`; it is duplicated only
 * because that one is not exported, and the two should become one.
 */
function fitLine(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = '…';
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(cut + ellipsis) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut.trimEnd() + ellipsis;
}

/** Find Sumeru logo image file if available on disk. */
function resolveLogoPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'packages/frontend/public/sumeru-logo.png'),
    path.resolve(__dirname, '../../../../frontend/public/sumeru-logo.png'),
    path.resolve(__dirname, '../../../../../packages/frontend/public/sumeru-logo.png'),
    path.resolve(process.cwd(), 'public/sumeru-logo.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function buildIdCardPdf(input: IdCardInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [CARD_WIDTH, CARD_HEIGHT], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Card background & border
    doc.rect(0, 0, CARD_WIDTH, CARD_HEIGHT).fill('#ffffff');
    doc.roundedRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 12).lineWidth(1.5).strokeColor('#e2e8f0').stroke();

    // 1. Header Banner
    doc.rect(0, 0, CARD_WIDTH, 66).fill(COLOR_PRIMARY);
    // Amber accent ribbon under header
    doc.rect(0, 63, CARD_WIDTH, 3).fill(COLOR_ACCENT);

    // Try embedding the Sumeru Global logo PNG
    const logoPath = resolveLogoPath();
    let textStartX = 24;
    if (logoPath) {
      try {
        doc.image(logoPath, 20, 14, { width: 44, height: 38 });
        textStartX = 72;
      } catch {
        textStartX = 24;
      }
    }

    const face = idCardTextLines(input);

    doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold')
      .text(face.brand, textStartX, 16, { continued: false });
    doc.fillColor('#94a3b8').fontSize(8.5).font('Helvetica')
      .text(face.subtitle, textStartX, 38);

    // 2. Candidate Photo Section
    const photoX = 24;
    const photoY = 82;
    const photoW = 120;
    const photoH = 146;

    doc.roundedRect(photoX, photoY, photoW, photoH, 8).lineWidth(2).strokeColor(COLOR_ACCENT).stroke();

    let photoRendered = false;
    if (input.photograph) {
      doc.save();
      try {
        doc.roundedRect(photoX + 2, photoY + 2, photoW - 4, photoH - 4, 6).clip();
        doc.image(input.photograph, photoX + 2, photoY + 2, {
          fit: [photoW - 4, photoH - 4],
          align: 'center',
          valign: 'center',
        });
        photoRendered = true;
      } catch {
        photoRendered = false;
      } finally {
        // Restored on the failure path too: an unreadable image used to leave the photo-box clip
        // in force, so everything drawn after it — name, ID, dates — was clipped off the card.
        doc.restore();
      }
    }

    if (!photoRendered) {
      // Elegant placeholder box with initials
      doc.roundedRect(photoX + 2, photoY + 2, photoW - 4, photoH - 4, 6).fillColor('#f1f5f9').fill();
      const initials = input.fullName
        .split(' ')
        .filter(Boolean)
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase() || 'AP';

      doc.fillColor(COLOR_GOLD).fontSize(26).font('Helvetica-Bold')
        .text(initials, photoX, photoY + 45, { width: photoW, align: 'center' });
      doc.fillColor(COLOR_MUTED).fontSize(8).font('Helvetica')
        .text('No photo on file', photoX, photoY + 85, { width: photoW, align: 'center' });
    }

    // 3. Candidate Data Grid (Right of photo). Every line is one line tall and cut to the column,
    // so a long name or department can never run into the line below it.
    const fieldX = photoX + photoW + 24;
    const fieldW = CARD_WIDTH - 24 - fieldX;
    let y = 82;

    // Role line
    doc.fillColor(COLOR_GOLD).fontSize(9).font('Helvetica-Bold');
    doc.text(fitLine(doc, face.role, fieldW), fieldX, y);
    y += 15;

    // Full name: step the size down before cutting anything off — a name is the last thing to shorten.
    let nameSize = 16;
    doc.fillColor(COLOR_PRIMARY).font('Helvetica-Bold').fontSize(nameSize);
    while (nameSize > 12 && doc.widthOfString(face.name) > fieldW) {
      nameSize -= 1;
      doc.fontSize(nameSize);
    }
    doc.text(fitLine(doc, face.name, fieldW), fieldX, y);
    y += 26;

    // ID badge, sized to its text
    doc.fontSize(10).font('Helvetica-Bold');
    const idText = fitLine(doc, face.idLine, fieldW - 16);
    const badgeW = Math.max(96, doc.widthOfString(idText) + 16);
    doc.roundedRect(fieldX, y, badgeW, 20, 4).fillColor('#fef3c7').fill();
    doc.roundedRect(fieldX, y, badgeW, 20, 4).strokeColor('#fde68a').lineWidth(0.8).stroke();
    doc.fillColor('#92400e').text(idText, fieldX + 8, y + 5);
    y += 28;

    // Location, department — each printed only when the record has it
    for (const field of face.fields) {
      doc.fillColor(COLOR_MUTED).fontSize(8.5).font('Helvetica');
      doc.text(field.label, fieldX, y);
      y += 11;
      doc.fillColor(COLOR_DARK).fontSize(11).font('Helvetica-Bold');
      doc.text(fitLine(doc, field.value, fieldW), fieldX, y);
      y += 20;
    }

    // 4. Bottom band: dates and small print on the left, signature block on the right
    const bandY = photoY + photoH + 10;
    doc.moveTo(24, bandY).lineTo(CARD_WIDTH - 24, bandY).strokeColor('#cbd5e1').lineWidth(1).stroke();

    const sigW = 160;
    const sigX = CARD_WIDTH - 24 - sigW;
    const leftW = sigX - 16 - 24;

    doc.fillColor(COLOR_MUTED).fontSize(8.5).font('Helvetica');
    doc.text(fitLine(doc, face.issued, leftW), 24, bandY + 10);
    doc.fillColor(COLOR_SUCCESS).fontSize(9).font('Helvetica-Bold');
    doc.text(fitLine(doc, face.validThru, leftW), 24, bandY + 23);

    let footY = bandY + 42;
    for (const line of face.footer) {
      doc.fillColor(COLOR_MUTED).fontSize(7).font('Helvetica');
      doc.text(fitLine(doc, line, leftW), 24, footY);
      footY += 10;
    }

    // The rule is always drawn, so a wet signature has somewhere to go even with nothing configured.
    const ruleY = bandY + 44;
    doc.moveTo(sigX, ruleY).lineTo(sigX + sigW, ruleY).strokeColor(COLOR_MUTED).lineWidth(0.6).stroke();
    let sigY = ruleY + 4;
    if (face.signatory.name) {
      doc.fillColor(COLOR_DARK).fontSize(8).font('Helvetica-Bold');
      doc.text(fitLine(doc, face.signatory.name, sigW), sigX, sigY);
      sigY += 11;
    }
    if (face.signatory.title) {
      doc.fillColor(COLOR_MUTED).fontSize(7).font('Helvetica');
      doc.text(fitLine(doc, face.signatory.title, sigW), sigX, sigY);
    }
    if (face.signatory.caption) {
      doc.fillColor(COLOR_MUTED).fontSize(7).font('Helvetica');
      doc.text(fitLine(doc, face.signatory.caption, sigW), sigX, sigY);
    }

    doc.end();
  });
}
