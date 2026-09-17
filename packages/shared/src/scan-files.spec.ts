import {
  scanMimeType, isDrawableScan, isDrawableScanType, scanFileName,
  SCAN_UPLOAD_IMAGE_ACCEPT, SCAN_UPLOAD_MIME_TYPES,
} from './index';

/**
 * WHY A STORED SCAN'S TYPE HAS TO BE WORKED OUT AT ALL.
 *
 * The routes that stream documents set no usable `Content-Type` — some send octet-stream, the rest
 * send nothing — and `nosniff` stops the browser guessing, so a blob read off one of them has an
 * empty type and any viewer handed it offers a download instead of the document. The filename is
 * the only thing that still knows. Four screens had four different versions of this knowledge and
 * two had none, which is exactly why it now lives in one place.
 */
describe('working out what a stored scan is', () => {
  it('recognises every type an upload is allowed to be', () => {
    for (const name of ['card.pdf', 'card.jpg', 'card.jpeg', 'p.png', 'p.webp', 'p.heic', 'p.heif', 'p.tif', 'p.tiff', 'p.bmp', 'p.gif']) {
      const type = scanMimeType(name);
      expect(type).not.toBeNull();
      expect(SCAN_UPLOAD_MIME_TYPES).toContain(type as string);
    }
  });

  it('reads the extension however it is written', () => {
    expect(scanMimeType('SCAN.PDF')).toBe('application/pdf');
    expect(scanMimeType('holiday.photo.JPEG')).toBe('image/jpeg');
    expect(scanMimeType('aadhaar-front.PnG')).toBe('image/png');
  });

  /** Opaque is the safe answer: the viewer already degrades to a download for what it cannot show. */
  it('answers nothing for anything it does not recognise', () => {
    expect(scanMimeType('report.docx')).toBeNull();
    expect(scanMimeType('noextension')).toBeNull();
    expect(scanMimeType('')).toBeNull();
    expect(scanMimeType(null)).toBeNull();
    expect(scanMimeType(undefined)).toBeNull();
  });

  /**
   * A branch flatbed writes TIFF and the upload rules accept it, but no browser draws one — so it
   * stays a link rather than becoming a broken thumbnail on a clerk's screen.
   */
  it('separates what a browser can draw from what it can only offer', () => {
    expect(isDrawableScan('photo.jpg')).toBe(true);
    expect(isDrawableScan('photo.png')).toBe(true);
    expect(isDrawableScan('scan.tiff')).toBe(false);
    expect(isDrawableScan('deed.pdf')).toBe(false);
    expect(isDrawableScan('mystery.dat')).toBe(false);
  });

  /** The viewer holds a type rather than a name, and asks the same question of it. */
  it('answers the same question asked by type', () => {
    expect(isDrawableScanType('image/jpeg')).toBe(true);
    expect(isDrawableScanType('image/tiff')).toBe(false);
    expect(isDrawableScanType('application/pdf')).toBe(false);
    expect(isDrawableScanType('application/octet-stream')).toBe(false);
    expect(isDrawableScanType(null)).toBe(false);
  });
});

describe('the picker that takes pictures but not documents', () => {
  it('is the shared list minus PDF, never a hand-written "image/*"', () => {
    expect(SCAN_UPLOAD_IMAGE_ACCEPT).not.toMatch(/pdf/);
    expect(SCAN_UPLOAD_IMAGE_ACCEPT.split(',').every((t) => t.startsWith('image/'))).toBe(true);
    // `image/*` would also have meant SVG, which is a script container, not a photograph.
    expect(SCAN_UPLOAD_IMAGE_ACCEPT).not.toMatch(/svg|\*/);
    for (const type of SCAN_UPLOAD_IMAGE_ACCEPT.split(',')) {
      expect(SCAN_UPLOAD_MIME_TYPES).toContain(type);
    }
  });
});

describe('naming a scan', () => {
  const when = new Date(2026, 8, 16, 14, 5, 11);

  it('names it after the document it answers', () => {
    expect(scanFileName('PAN card', 'pdf', when)).toBe('pan-card.pdf');
    expect(scanFileName('Aadhaar — back', 'jpg', when)).toBe('aadhaar-back.jpg');
  });

  it('numbers the pages of a document that has several', () => {
    expect(scanFileName('Joining form', 'jpg', when, 1)).toBe('joining-form-page-1.jpg');
    expect(scanFileName('Joining form', 'jpg', when, 2)).toBe('joining-form-page-2.jpg');
  });

  /** Eight files on a record all named after the clock is what this replaces. */
  it('falls back to the time only when nothing says what the document is', () => {
    expect(scanFileName(null, 'pdf', when)).toBe('Scan_2026-09-16_14-05-11.pdf');
    expect(scanFileName('', 'pdf', when)).toBe('Scan_2026-09-16_14-05-11.pdf');
    expect(scanFileName('!!!', 'pdf', when)).toBe('Scan_2026-09-16_14-05-11.pdf');
  });
});
