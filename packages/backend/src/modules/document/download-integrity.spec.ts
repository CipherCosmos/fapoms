import { createHash } from 'crypto';
import { PassThrough, Readable } from 'stream';
import { DocumentController } from './document.controller';
import { integrityGate, DocumentIntegrityMismatchError, hasRecordedSha256 } from './download-integrity';

/**
 * `documents.content_sha256` was written at upload and never read again: a stored object replaced
 * afterwards (the presigned-URL overwrite, or anyone with bucket write access) was served as the
 * recorded evidence. The download now checks the hash before it releases the file.
 */
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const drain = (s: NodeJS.ReadableStream) => new Promise<{ data: Buffer; error: any }>((resolve) => {
  const parts: Buffer[] = [];
  s.on('data', (c: Buffer) => parts.push(c));
  s.on('end', () => resolve({ data: Buffer.concat(parts), error: null }));
  s.on('error', (error) => resolve({ data: Buffer.concat(parts), error }));
});

describe('integrityGate', () => {
  const file = Buffer.alloc(200_000, 3);

  it('passes a matching file through unchanged', async () => {
    const out = await drain(Readable.from([file.subarray(0, 70_000), file.subarray(70_000)]).pipe(integrityGate(sha(file))));
    expect(out.error).toBeNull();
    expect(out.data).toEqual(file);
  });

  it('releases NOTHING of a mismatching file within the hold limit', async () => {
    const gate = integrityGate(sha(Buffer.from('the original')));
    const out = await drain(Readable.from([file.subarray(0, 70_000), file.subarray(70_000)]).pipe(gate));
    expect(out.error).toBeInstanceOf(DocumentIntegrityMismatchError);
    expect(out.data.length).toBe(0);
  });

  it('past the hold limit, still withholds the tail of a mismatching file so the transfer comes up short', async () => {
    const gate = integrityGate(sha(Buffer.from('the original')), 50_000);
    const chunks = [0, 1, 2, 3].map((i) => file.subarray(i * 50_000, (i + 1) * 50_000));
    const out = await drain(Readable.from(chunks).pipe(gate));
    expect(out.error).toBeInstanceOf(DocumentIntegrityMismatchError);
    expect(out.data.length).toBeLessThan(file.length);
  });

  it('only rows carrying a real hash are checked', () => {
    expect(hasRecordedSha256(sha(file))).toBe(true);
    expect(hasRecordedSha256(sha(file).toUpperCase())).toBe(true);
    expect(hasRecordedSha256(null)).toBe(false);
    expect(hasRecordedSha256('')).toBe(false);
    expect(hasRecordedSha256('abc')).toBe(false);
  });
});

describe('GET /documents/:id/download — verifies the stored file against its recorded hash', () => {
  const ORIGINAL = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 1)]);
  const REPLACED = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(4096, 2)]);

  function fakeRes() {
    const sink = new PassThrough();
    const parts: Buffer[] = [];
    sink.on('data', (c: Buffer) => parts.push(c));
    const res: any = sink;
    res.headers = {} as Record<string, any>;
    res.headersSent = false;
    res.statusCode = 200;
    res.setHeader = (k: string, v: any) => { res.headers[k] = v; };
    res.removeHeader = (k: string) => { delete res.headers[k]; };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.jsonBody = b; sink.end(); return res; };
    res.body = () => Buffer.concat(parts);
    res.finished = new Promise<void>((resolve) => { sink.on('finish', resolve); sink.on('close', resolve); });
    return res;
  }

  function build(stored: Buffer, contentSha256: string | null) {
    const documentService = {
      findOne: jest.fn(async () => ({ id: 'doc-1', fileName: 'p.pdf', filePath: 'uploads/2026/09/x.pdf', mimeType: 'application/pdf', contentSha256 })),
    };
    const storage = {
      statFile: jest.fn(async () => ({ size: stored.length, mtimeMs: 1 })),
      getFileStream: jest.fn(async () => Readable.from([stored])),
    };
    const tokens = { verify: jest.fn() };
    const controller = new DocumentController(
      documentService as any, storage as any, null as any, null as any, null as any, null as any, null as any,
      tokens as any, null as any, null as any, null as any, null as any, null as any,
    );
    (controller as any).logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    return controller;
  }

  it('serves the file when storage still holds what was recorded', async () => {
    const controller = build(ORIGINAL, sha(ORIGINAL));
    const res = fakeRes();
    await controller.downloadFile('doc-1', 'tok', { headers: {} }, res);
    await res.finished;
    expect(res.statusCode).toBe(200);
    expect(res.body()).toEqual(ORIGINAL);
  });

  it('refuses — no bytes, a 500 naming the mismatch, and a loud log — when storage holds something else', async () => {
    const controller = build(REPLACED, sha(ORIGINAL));
    const res = fakeRes();
    await controller.downloadFile('doc-1', 'tok', { headers: {} }, res);
    await res.finished;
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.code).toBe('DOCUMENT_INTEGRITY_MISMATCH');
    expect(res.body().includes(REPLACED)).toBe(false);
    expect(res.headers['Content-Length']).toBeUndefined();
    expect(res.headers['Content-Disposition']).toBeUndefined();
    expect((controller as any).logger.error).toHaveBeenCalledWith(expect.stringMatching(/INTEGRITY MISMATCH on document doc-1/));
  });

  it('serves a row recorded before integrity existed exactly as before', async () => {
    const controller = build(REPLACED, null);
    const res = fakeRes();
    await controller.downloadFile('doc-1', 'tok', { headers: {} }, res);
    await res.finished;
    expect(res.body()).toEqual(REPLACED);
  });
});
