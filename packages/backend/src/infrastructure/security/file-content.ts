import { BadRequestException } from '@nestjs/common';
import { ASSAYER_ERROR_CODES } from '@fapoms/shared';
import { withCode } from '../http/api-error';

/**
 * What an uploaded file really is, read from its own bytes — and the refusal of anything that is
 * not one of the formats this application handles.
 *
 * Every upload route checked the type the CLIENT declared (and, for `application/octet-stream`,
 * the file's extension). Both are labels the uploader writes. Malware scanning then caught what
 * ClamAV knows by signature, which left a whole class through: a program renamed `return.pdf`, an
 * HTML page labelled `image/jpeg`, a ZIP of anything, a PDF truncated mid-upload. None of those is
 * known malware; all of them were stored and later opened by staff. This is the content half of the
 * gate `FileScanService.scanOrThrow` applies to every upload — see that method.
 *
 * The bytes decide. A label is only consulted to catch a file that claims to be one kind of thing
 * and is another; within a family (a HEIC a phone labelled JPEG) that is tolerated, because the
 * viewer copes and the uploader did nothing wrong.
 */

/** Leading-byte signatures. The one table — `document-integrity.ts` sniffs with it too. */
const SIGNATURES: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },                 // %PDF
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },                       // GIF8
  { mime: 'image/webp', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },           // RIFF....WEBP
  { mime: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  // ZIP container. Office documents (.xlsx, .docx) and .zip share it; the container is as far as
  // magic bytes can honestly take us — `classifyUpload` looks inside for the spreadsheet parts.
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x05, 0x06] },
  // Legacy Office compound binary (.xls, .doc).
  { mime: 'application/vnd.ms-office', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** HEIC/HEIF: an ISO-BMFF `ftyp` box whose brand names an image, not a video. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);

/** MIME type read from the file's own leading bytes, or null when unrecognised. */
export function sniffMimeType(buffer: Buffer): string | null {
  for (const sig of SIGNATURES) {
    const at = sig.offset ?? 0;
    if (buffer.length < at + sig.bytes.length) continue;
    let hit = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[at + i] !== sig.bytes[i]) { hit = false; break; }
    }
    if (hit) return sig.mime;
  }
  // BMP's own signature is two letters, "BM" — which a CSV starting "BMW,…" also begins with. The
  // header behind it is what makes it an image: reserved bytes 6-9 are zero and the info header at
  // 14 is one of the sizes the format defines.
  if (
    buffer.length >= 18 && buffer[0] === 0x42 && buffer[1] === 0x4d && buffer.readUInt32LE(6) === 0 &&
    [12, 40, 52, 56, 64, 108, 124].includes(buffer.readUInt32LE(14))
  ) {
    return 'image/bmp';
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buffer.toString('latin1', 8, 12);
    if (HEIF_BRANDS.has(brand)) return brand === 'heic' || brand === 'heix' ? 'image/heic' : 'image/heif';
  }
  return null;
}

export type UploadFamily = 'pdf' | 'image' | 'spreadsheet';

const FAMILY_OF_TYPE: Record<string, UploadFamily> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image', 'image/jpg': 'image', 'image/pjpeg': 'image', 'image/png': 'image',
  'image/webp': 'image', 'image/heic': 'image', 'image/heif': 'image', 'image/tiff': 'image',
  'image/bmp': 'image', 'image/gif': 'image',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'spreadsheet',
  'application/vnd.ms-excel': 'spreadsheet',
  'text/csv': 'spreadsheet', 'application/csv': 'spreadsheet',
};

const FAMILY_OF_EXTENSION: Record<string, UploadFamily> = {
  pdf: 'pdf',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', heic: 'image', heif: 'image',
  tif: 'image', tiff: 'image', bmp: 'image', gif: 'image',
  xlsx: 'spreadsheet', xls: 'spreadsheet', csv: 'spreadsheet',
};

/**
 * How a refusal names a kind of file. Plain words, because the person most often reading them is a
 * candidate on a phone attaching an ID card — "a photo", not "an image/jpeg".
 */
const FAMILY_WORDS: Record<UploadFamily, string> = { pdf: 'a PDF', image: 'a photo', spreadsheet: 'a spreadsheet' };

/**
 * What to upload instead of a type we cannot use. Spreadsheets are named only when the file itself
 * said it was one (an import): a candidate attaching an ID card must not be told to try Excel.
 */
function unusableTypeMessage(claimed?: UploadFamily | null): string {
  return claimed === 'spreadsheet'
    ? "This file type can't be used. Upload an Excel or CSV file."
    : "This file type can't be used. Upload a photo or a PDF.";
}

/**
 * Plain text a CSV import could be: no NUL bytes, almost no control characters, and not markup or
 * a script wearing a `.csv`. Encoding is deliberately not policed — Excel on Windows writes
 * Windows-1252, and refusing that would refuse the customer masters people actually have.
 */
function looksLikeDelimitedText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 64 * 1024);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control++;
  }
  if (control > sample.length / 100) return false;
  // A UTF-8 byte-order mark, as it reads in latin1, is not content.
  const head = sample.toString('latin1', 0, 512).replace(/^\xEF\xBB\xBF/, '').trimStart();
  return !(head.startsWith('<') || head.startsWith('#!') || head.startsWith('MZ'));
}

/**
 * A legacy compound-binary (OLE/CFB) file is a spreadsheet only when it carries Excel's workbook
 * stream. The same container holds Word `.doc`, Outlook `.msg`, `.msi` installers and more; the
 * magic bytes alone cannot tell them apart. Directory entry names are UTF-16LE: Excel 97+ writes
 * `Workbook`, Excel 5/95 wrote `Book`.
 */
const LEGACY_WORKBOOK_STREAMS = [Buffer.from('Workbook', 'utf16le'), Buffer.from('Book\0', 'utf16le')];
function isLegacyWorkbook(buffer: Buffer): boolean {
  return LEGACY_WORKBOOK_STREAMS.some((name) => buffer.includes(name));
}

/** An .xlsx is a ZIP whose entries include these parts; their names sit uncompressed in the archive. */
function isSpreadsheetZip(buffer: Buffer): boolean {
  return buffer.includes('[Content_Types].xml') && buffer.includes('xl/workbook');
}

export interface UploadClassification {
  family: UploadFamily;
  /** The real type, from the bytes. */
  mimeType: string;
}

function refuse(message: string): never {
  throw withCode(new BadRequestException(message), ASSAYER_ERROR_CODES.UPLOAD_REJECTED);
}

/**
 * What these bytes are, or a 400 saying why they are not something this application accepts.
 *
 * Accepted: a PDF that ends properly, the still-image formats a phone or desk scanner produces, an
 * .xlsx workbook, a legacy .xls, and delimited text for CSV imports. Everything else — executables,
 * scripts, HTML/SVG/XML, archives, Word documents, empty files, unreadable bytes — is refused here,
 * whatever it was called.
 */
export function classifyUpload(buffer: Buffer, claimed?: UploadFamily | null): UploadClassification {
  if (!buffer || buffer.length === 0) refuse('This file is empty. Choose the file again.');

  const sniffed = sniffMimeType(buffer);
  switch (sniffed) {
    case 'application/pdf': {
      // A PDF's trailer is its last part; one that never arrived means the upload was cut short or
      // the file is damaged, and it will not open for the person who has to read it.
      if (buffer.lastIndexOf('%%EOF') === -1) {
        refuse('This PDF is damaged or incomplete. Save it again, or upload a photo instead.');
      }
      return { family: 'pdf', mimeType: sniffed };
    }
    case 'image/png':
      if (!buffer.includes('IEND')) refuse('This file is damaged or incomplete. Take the photo again or choose another file.');
      return { family: 'image', mimeType: sniffed };
    case 'image/jpeg':
    case 'image/gif':
    case 'image/webp':
    case 'image/tiff':
    case 'image/bmp':
    case 'image/heic':
    case 'image/heif':
      return { family: 'image', mimeType: sniffed };
    case 'application/zip':
      if (isSpreadsheetZip(buffer)) {
        return { family: 'spreadsheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
      }
      return refuse(unusableTypeMessage(claimed));
    case 'application/vnd.ms-office':
      if (isLegacyWorkbook(buffer)) return { family: 'spreadsheet', mimeType: 'application/vnd.ms-excel' };
      return refuse(unusableTypeMessage(claimed));
    default:
      if (looksLikeDelimitedText(buffer)) return { family: 'spreadsheet', mimeType: 'text/csv' };
      return refuse(unusableTypeMessage(claimed));
  }
}

/** What the uploader said it was: the declared type where it says anything, else the extension. */
function claimedFamily(declaredType?: string | null, fileName?: string | null): UploadFamily | null {
  const declared = (declaredType || '').toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream') {
    const fromType = FAMILY_OF_TYPE[declared];
    if (fromType) return fromType;
  }
  return FAMILY_OF_EXTENSION[fileExtension(fileName)] ?? null;
}

/** Lower-case extension after the last dot, or '' when the name has none. */
function fileExtension(fileName?: string | null): string {
  const name = (fileName || '').toLowerCase().trim();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1);
}

/**
 * Refuse a file whose bytes are not an accepted format, or that claims to be one kind of file and
 * is another (a "PDF" that is really a photo, a "spreadsheet" that is really a PDF). Returns what
 * the file really is.
 */
export function assertUploadContent(
  buffer: Buffer,
  meta: { fileName?: string | null; declaredType?: string | null } = {},
): UploadClassification {
  const claimed = claimedFamily(meta.declaredType, meta.fileName);
  const actual = classifyUpload(buffer, claimed);
  // A legacy Office binary is only accepted under its own name. A compound file that happens to
  // carry a workbook stream but is called `invoice.pdf`, `photo.jpg` — or has no name at all —
  // is not something any route here asked for.
  if (actual.mimeType === 'application/vnd.ms-excel' && fileExtension(meta.fileName) !== 'xls') {
    refuse('This is an old-style Excel file. Save it with a .xls name, or as .xlsx, and upload it again.');
  }
  if (claimed && claimed !== actual.family) {
    const really = actual.mimeType === 'text/csv' ? 'plain text' : FAMILY_WORDS[actual.family];
    refuse(`This file is ${really}, not ${FAMILY_WORDS[claimed]}. Choose the right file.`);
  }
  return actual;
}
