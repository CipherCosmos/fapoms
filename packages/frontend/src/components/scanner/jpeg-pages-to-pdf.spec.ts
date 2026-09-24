import { jpegPagesToPdf, readJpegInfo } from './jpeg-pages-to-pdf';

/**
 * A multi-page scan used to upload page 1 and drop the rest. The pages now travel as one PDF, and
 * the server refuses a PDF with no `%%EOF` or whose bytes are not what the name says — so what is
 * pinned here is the structure a PDF reader (and that check) needs, not just "some bytes came out".
 */

/** The smallest byte string `readJpegInfo` accepts: SOI, a JFIF header, a frame header, EOI. */
function fakeJpeg(width: number, height: number, components = 3, marker = 0xc0, filler = 0x11): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [
    0xff, marker, 0x00, 8 + components * 3, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, components,
    ...Array.from({ length: components * 3 }, () => 0x01),
  ];
  const body = Array.from({ length: 40 }, () => filler);
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...body, 0xff, 0xd9]);
}

const asText = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

describe('reading a JPEG frame header', () => {
  it('finds the size and channel count after the JFIF header', () => {
    expect(readJpegInfo(fakeJpeg(1600, 1200))).toEqual({ width: 1600, height: 1200, components: 3 });
  });

  it('reads a progressive frame as well as a baseline one', () => {
    expect(readJpegInfo(fakeJpeg(800, 600, 1, 0xc2))).toEqual({ width: 800, height: 600, components: 1 });
  });

  it('refuses something that is not a JPEG at all', () => {
    expect(() => readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/Not a JPEG/);
  });
});

describe('putting scanned pages into one PDF', () => {
  const pages = [fakeJpeg(1500, 2000, 3, 0xc0, 0x21), fakeJpeg(1500, 2000, 3, 0xc0, 0x22), fakeJpeg(2000, 1260, 3, 0xc0, 0x23)];
  const pdf = jpegPagesToPdf(pages);
  const text = asText(pdf);

  it('starts with a PDF header', () => {
    expect(text.startsWith('%PDF-1.')).toBe(true);
  });

  it('ends with %%EOF — the server refuses a PDF that does not', () => {
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('has one page per scanned image', () => {
    expect(text).toMatch(/\/Type \/Pages \/Kids \[[^\]]+\] \/Count 3/);
    expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
  });

  it('embeds each JPEG unchanged, decoded by the reader', () => {
    expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(3);
    pages.forEach((page) => expect(text).toContain(asText(page)));
  });

  it('sizes each page to its own image', () => {
    // 1500 × 2000 px at 150 dpi is 720 × 960 pt; the landscape page keeps its own proportions.
    expect(text).toContain('/MediaBox [0 0 720 960]');
    expect(text).toContain('/MediaBox [0 0 960 604.8]');
  });

  it('points startxref at the cross-reference table, and every entry at its object', () => {
    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const entries = [...text.slice(startxref).matchAll(/(\d{10}) 00000 n \n/g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(2 + 3 * 3);
    entries.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it('writes every cross-reference entry at the 20 bytes the format requires', () => {
    const table = text.slice(text.indexOf('xref\n'), text.indexOf('trailer'));
    table.split('\n').slice(2, -1).forEach((line) => expect(`${line}\n`).toHaveLength(20));
  });

  it('declares image lengths that match the bytes embedded', () => {
    const lengths = [...text.matchAll(/\/Subtype \/Image [^>]*\/Length (\d+) >>/g)].map((m) => Number(m[1]));
    expect(lengths).toEqual(pages.map((p) => p.length));
  });

  it('refuses to make an empty PDF', () => {
    expect(() => jpegPagesToPdf([])).toThrow();
  });
});
