/**
 * SEVERAL SCANNED PAGES, ONE FILE.
 *
 * The scanner hands back one JPEG per page. A document row on the registration form holds one
 * upload, so a three-page rent agreement used to arrive as page 1 and nothing else. This wraps the
 * pages into a single PDF instead: each JPEG is embedded as-is (`DCTDecode` — the PDF reader
 * decodes the JPEG itself, so nothing is re-compressed and the bytes the scanner produced are the
 * bytes that are kept), one page per image, the page sized to the image.
 *
 * No dependency on purpose: a PDF of whole JPEG images is a handful of objects and a cross-reference
 * table, and the server refuses a PDF that does not end in `%%EOF` or whose content does not match
 * its name — so the structure here is written out completely rather than approximated.
 */

export interface JpegInfo {
  width: number;
  height: number;
  /** 1 = grey, 3 = colour, 4 = CMYK. */
  components: number;
}

/**
 * Pixels per inch the page is laid out at. The page keeps the image's own proportions; this only
 * decides how big it prints — 150 dpi puts a 2000px-long scan on roughly an A4 sheet, where 72 dpi
 * would make it a poster.
 */
const LAYOUT_DPI = 150;

/** Reads the frame header of a JPEG: its size and how many colour channels it carries. */
export function readJpegInfo(bytes: Uint8Array): JpegInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Not a JPEG image.');
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    // Fill bytes, and the markers that stand alone with no length after them.
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    // Start-of-frame: C0–CF, except C4 (Huffman tables), C8 (reserved) and CC (arithmetic tables).
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 >= bytes.length) break;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const components = bytes[i + 9];
      if (!width || !height) break;
      return { width, height, components };
    }
    if (marker === 0xd9 || marker === 0xda) break; // End of image, or start of scan data.
    i += 2 + length;
  }
  throw new Error('The JPEG has no readable frame header.');
}

const encoder = new TextEncoder();
const ascii = (s: string): Uint8Array => encoder.encode(s);

const colourSpace = (components: number): string => (
  components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB'
);

/** Two decimal places at most — PDF numbers, not JavaScript floats. */
const num = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * One PDF, one page per JPEG, in the order given.
 *
 * Object layout: 1 = catalog, 2 = page tree, then three objects per page — the page, its image and
 * its content stream (which draws the image across the whole page).
 */
export function jpegPagesToPdf(pages: Uint8Array[]): Uint8Array {
  if (pages.length === 0) throw new Error('No pages to put in the PDF.');

  const chunks: Uint8Array[] = [];
  const offsets: number[] = []; // offsets[n] = byte offset of object n (index 0 unused).
  let length = 0;
  const push = (part: Uint8Array) => { chunks.push(part); length += part.length; };
  const text = (s: string) => push(ascii(s));

  // The header, and a comment of high bytes so any transfer treats the file as binary.
  text('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageIds = pages.map((_, n) => 3 + n * 3);
  const beginObject = (id: number) => { offsets[id] = length; text(`${id} 0 obj\n`); };

  beginObject(1);
  text('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  beginObject(2);
  text(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((jpeg, n) => {
    const info = readJpegInfo(jpeg);
    const pageId = pageIds[n];
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const w = num((info.width * 72) / LAYOUT_DPI);
    const h = num((info.height * 72) / LAYOUT_DPI);
    const imageName = `Im${n + 1}`;

    beginObject(pageId);
    text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
      + `/Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`,
    );

    beginObject(imageId);
    text(
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} `
      + `/ColorSpace ${colourSpace(info.components)} /BitsPerComponent 8 /Filter /DCTDecode `
      // Adobe's CMYK JPEGs are stored inverted; the decode array puts them the right way round.
      + `${info.components === 4 ? '/Decode [1 0 1 0 1 0 1 0] ' : ''}/Length ${jpeg.length} >>\nstream\n`,
    );
    push(jpeg);
    text('\nendstream\nendobj\n');

    const draw = ascii(`q ${w} 0 0 ${h} 0 0 cm /${imageName} Do Q`);
    beginObject(contentId);
    text(`<< /Length ${draw.length} >>\nstream\n`);
    push(draw);
    text('\nendstream\nendobj\n');
  });

  // The cross-reference table: every entry exactly 20 bytes, as the format requires.
  const objectCount = 2 + pages.length * 3;
  const xrefAt = length;
  text(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= objectCount; id++) {
    text(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  text(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of chunks) { out.set(part, at); at += part.length; }
  return out;
}

/** The bytes of a Blob, through whichever reader this browser has. */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the scan.'));
    reader.readAsArrayBuffer(blob);
  });
}
