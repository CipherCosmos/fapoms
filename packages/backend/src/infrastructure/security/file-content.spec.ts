import { assertUploadContent, classifyUpload, sniffMimeType } from './file-content';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('....IHDR....IDAT....IEND\xaeB`\x82', 'latin1'),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1')]);
const BMP = (() => {
  const b = Buffer.alloc(64);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(64, 2);
  b.writeUInt32LE(0, 6);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  return b;
})();
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....xl/workbook.xml....', 'latin1')]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml', 'latin1')]);
const XLS = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
const CSV = Buffer.from('SOL ID,Branch Name,City\n00123,BMW Road,Pune\n');
const CSV_1252 = Buffer.from([...Buffer.from('name,city\nJos'), 0xe9, ...Buffer.from(',Pune\n')]);

const EXE = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'), Buffer.alloc(200)]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), Buffer.alloc(100)]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const SHELL = Buffer.from('#!/bin/sh\nrm -rf /\n');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....payload.exe....', 'latin1')]);
const TRUNCATED_PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n');
const TRUNCATED_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('....IHDR....IDAT')]);

describe('classifyUpload — the bytes decide', () => {
  it.each([
    ['PDF', PDF, 'pdf'],
    ['PNG', PNG, 'image'],
    ['JPEG', JPEG, 'image'],
    ['HEIC (iPhone photo)', HEIC, 'image'],
    ['BMP (desk scanner)', BMP, 'image'],
    ['XLSX workbook', XLSX, 'spreadsheet'],
    ['legacy XLS', XLS, 'spreadsheet'],
    ['CSV', CSV, 'spreadsheet'],
    ['CSV in Windows-1252 (Excel on Windows)', CSV_1252, 'spreadsheet'],
  ])('accepts a real %s', (_label, bytes, family) => {
    expect(classifyUpload(bytes).family).toBe(family);
  });

  it.each([
    ['a Windows executable', EXE],
    ['a Linux executable', ELF],
    ['an HTML page', HTML],
    ['an SVG with script', SVG],
    ['a shell script', SHELL],
    ['a ZIP archive', ZIP],
    ['a Word document', DOCX],
    ['a truncated PDF', TRUNCATED_PDF],
    ['a truncated PNG', TRUNCATED_PNG],
    ['an empty file', Buffer.alloc(0)],
  ])('refuses %s', (_label, bytes) => {
    expect(() => classifyUpload(bytes)).toThrow();
  });

  it('does not mistake a CSV starting "BM" for a bitmap', () => {
    expect(sniffMimeType(Buffer.from('BMW Road,Pune,411001\n'))).toBeNull();
    expect(classifyUpload(Buffer.from('BMW Road,Pune,411001\n')).family).toBe('spreadsheet');
  });
});

describe('assertUploadContent — a label cannot disguise the bytes', () => {
  it('refuses a program renamed return.pdf, whatever type it declares', () => {
    expect(() => assertUploadContent(EXE, { fileName: 'return.pdf', declaredType: 'application/pdf' })).toThrow();
    expect(() => assertUploadContent(EXE, { fileName: 'return.pdf', declaredType: 'application/octet-stream' })).toThrow();
  });

  it('refuses a photo labelled as a PDF, and a PDF labelled as a spreadsheet', () => {
    expect(() => assertUploadContent(JPEG, { fileName: 'return.pdf', declaredType: 'application/pdf' }))
      .toThrow(/is a photo, not a PDF\. Choose the right file/);
    expect(() => assertUploadContent(PDF, { fileName: 'branches.xlsx' })).toThrow(/spreadsheet/);
  });

  it('names plain text as plain text, not a spreadsheet, when it poses as an image', () => {
    expect(() => assertUploadContent(Buffer.from('fake image'), { fileName: 'photo.jpg', declaredType: 'image/jpeg' }))
      .toThrow(/is plain text, not a photo/);
  });

  it('tolerates a mislabel within the same family (a HEIC a phone called JPEG)', () => {
    expect(assertUploadContent(HEIC, { fileName: 'IMG_0001.jpg', declaredType: 'image/jpeg' }).mimeType).toBe('image/heic');
  });

  it('uses the extension when the declared type says nothing', () => {
    expect(() => assertUploadContent(PDF, { fileName: 'photo.png', declaredType: 'application/octet-stream' })).toThrow();
    expect(assertUploadContent(PDF, { fileName: 'scan', declaredType: 'application/octet-stream' }).family).toBe('pdf');
  });
});

/**
 * The person most often reading these is a candidate on a phone attaching an ID card. The
 * refusals used to say "no end-of-file marker" and suggest Excel/CSV to somebody uploading a PAN
 * card; each now says, in a few plain words, what to do next.
 */
describe('refusals a candidate on a phone can act on', () => {
  const messageOf = (fn: () => unknown): string => {
    try { fn(); } catch (e) { return (e as Error).message; }
    throw new Error('expected a refusal');
  };

  it.each([
    ['an empty file', () => classifyUpload(Buffer.alloc(0))],
    ['a truncated PDF', () => classifyUpload(TRUNCATED_PDF)],
    ['a truncated PNG', () => classifyUpload(TRUNCATED_PNG)],
    ['a Word document', () => classifyUpload(DOCX)],
    ['a program', () => classifyUpload(EXE)],
    ['a mislabelled photo', () => assertUploadContent(JPEG, { fileName: 'pan.pdf' })],
  ])('refuses %s in short plain words, with no jargon', (_label, fn) => {
    const message = messageOf(fn);
    expect(message.split(/\s+/).length).toBeLessThanOrEqual(16);
    expect(message).not.toMatch(/end-of-file|marker|MIME|archive|re-upload/i);
  });

  it('tells a damaged file to be taken again', () => {
    expect(messageOf(() => classifyUpload(TRUNCATED_PNG))).toMatch(/damaged or incomplete.*Take the photo again/);
    expect(messageOf(() => classifyUpload(TRUNCATED_PDF))).toMatch(/damaged or incomplete/);
  });

  it('never suggests a spreadsheet to somebody uploading a photo or an ID', () => {
    for (const [bytes, fileName] of [[DOCX, 'aadhaar.docx'], [EXE, 'photo.jpg'], [ZIP, 'pan.pdf'], [HTML, undefined]] as const) {
      const message = messageOf(() => assertUploadContent(bytes, { fileName }));
      expect(message).not.toMatch(/excel|csv|spreadsheet/i);
    }
    expect(messageOf(() => classifyUpload(DOCX))).toMatch(/Upload a photo or a PDF/);
  });

  it('names Excel or CSV only to a file that called itself a spreadsheet — an import', () => {
    expect(messageOf(() => assertUploadContent(ZIP, { fileName: 'branches.xlsx' }))).toMatch(/Excel or CSV/);
  });

  it('keeps the upload-rejected code on every refusal', () => {
    expect.assertions(1);
    try { classifyUpload(DOCX); } catch (e) {
      expect(JSON.stringify((e as { getResponse(): unknown }).getResponse())).toContain('UPLOAD_REJECTED');
    }
  });
});
