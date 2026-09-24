import { BadRequestException, ConflictException } from '@nestjs/common';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { DocumentController } from './document.controller';
import { finalKeyForDirectUpload, directUploadKeyFor, PRESIGN_UPLOAD_EXPIRY_SECONDS } from './direct-upload-key';

/**
 * The presigned direct upload could be overwritten after it was finalized.
 *
 * The document row used to point at `documents/direct/<uuid>/<name>` — the very key the client
 * still held a live PUT URL for (15 minutes of it). A second PUT after finalize replaced a scanned,
 * hashed, registered document with anything at all, and every later download served it.
 *
 * Pinned here: finalize reads the object ONCE, writes that same scanned buffer to a server-owned
 * key, registers the row there, and deletes the direct object; the URL is minted for 5 minutes.
 */
describe('presigned direct upload — finalize moves the bytes off the client-writable key', () => {
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 7)]);
  const DIRECT = 'documents/direct/0b8a4a8e-6b7e-4a51-9d5c-3f1e2d4c5b6a/Packet_North.pdf';
  const FINAL = 'documents/final/0b8a4a8e-6b7e-4a51-9d5c-3f1e2d4c5b6a.pdf';

  let objects: Map<string, Buffer>;
  let storage: any;
  let documentService: any;
  let fileScanner: any;
  let controller: DocumentController;

  const body = () => ({
    objectKey: DIRECT, fileName: 'Packet North.pdf', contentType: 'application/pdf', type: 'PRE_FIELD_AUDIT_PDF',
  }) as any;
  const req = { user: { id: 'desk-1' } };

  beforeEach(() => {
    objects = new Map([[DIRECT, PDF]]);
    storage = {
      getSignedUploadUrl: jest.fn(async () => 'https://store/put'),
      statFile: jest.fn(async (k: string) => {
        if (!objects.has(k)) throw new Error('NoSuchKey');
        return { size: objects.get(k)!.length, mtimeMs: 0 };
      }),
      getFileStream: jest.fn(async (k: string) => Readable.from([objects.get(k)!])),
      saveFileAt: jest.fn(async (k: string, buf: Buffer) => { objects.set(k, Buffer.from(buf)); return k; }),
      deleteFile: jest.fn(async (k: string) => { objects.delete(k); }),
      sealObject: jest.fn(),
    };
    const rows: any[] = [];
    documentService = {
      findByFilePath: jest.fn(async (p: string) => rows.find((r) => r.filePath === p) ?? null),
      create: jest.fn(async (dto: any) => { const row = { id: `doc-${rows.length + 1}`, ...dto }; rows.push(row); return row; }),
    };
    fileScanner = { scanOrThrow: jest.fn(async () => undefined) };
    controller = new DocumentController(
      documentService, storage, null as any, null as any, null as any, null as any, null as any,
      null as any, null as any, fileScanner, null as any, null as any, null as any,
    );
  });

  it('mints the upload URL for five minutes, not fifteen', async () => {
    const res = await controller.presignUpload({ fileName: 'a.pdf', contentType: 'application/pdf' } as any);
    expect(PRESIGN_UPLOAD_EXPIRY_SECONDS).toBe(300);
    expect(res.expiresIn).toBe(300);
    expect(storage.getSignedUploadUrl).toHaveBeenCalledWith(res.objectKey, 'application/pdf', 300);
    expect(() => finalKeyForDirectUpload(res.objectKey)).not.toThrow();
  });

  it('registers the document at the server-owned key, never at the direct key', async () => {
    const doc: any = await controller.finalizeUpload(body(), req);

    expect(doc.filePath).toBe(FINAL);
    expect(doc.filePath.startsWith('documents/direct/')).toBe(false);
    expect(storage.saveFileAt).toHaveBeenCalledWith(FINAL, expect.any(Buffer), 'application/pdf');
    // The direct object is gone, so a late PUT lands on a key nothing refers to.
    expect(objects.has(DIRECT)).toBe(false);
    expect(objects.get(FINAL)).toEqual(PDF);
  });

  it('writes exactly the buffer that was scanned and hashed — one read, no second look at the direct key', async () => {
    const doc: any = await controller.finalizeUpload(body(), req);

    const scanned: Buffer = fileScanner.scanOrThrow.mock.calls[0][0];
    const written: Buffer = storage.saveFileAt.mock.calls[0][1];
    expect(written).toBe(scanned);
    expect(storage.getFileStream).toHaveBeenCalledTimes(1);
    expect(doc.integrity.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    // The in-place re-read-and-seal of the client-writable object is not how the bytes are sealed any more.
    expect(storage.sealObject).not.toHaveBeenCalled();
  });

  it('a PUT after finalize cannot change the registered document; a retried finalize returns the same row and deletes the late object', async () => {
    const first: any = await controller.finalizeUpload(body(), req);

    // The URL is still live: someone PUTs a different file to the direct key.
    objects.set(DIRECT, Buffer.from('%PDF-1.7\nREPLACEMENT'));
    const second: any = await controller.finalizeUpload(body(), req);

    expect(second.id).toBe(first.id);
    expect(documentService.create).toHaveBeenCalledTimes(1);
    expect(objects.get(FINAL)).toEqual(PDF);
    expect(objects.has(DIRECT)).toBe(false);
  });

  it('refuses when the object changed between the size check and the read', async () => {
    storage.statFile.mockResolvedValueOnce({ size: PDF.length + 1, mtimeMs: 0 });
    await expect(controller.finalizeUpload(body(), req)).rejects.toThrow(ConflictException);
    expect(storage.saveFileAt).not.toHaveBeenCalled();
    expect(documentService.create).not.toHaveBeenCalled();
  });

  it('removes the final object when the row cannot be created, and keeps the direct one for a retry', async () => {
    documentService.create.mockRejectedValueOnce(new Error('db down'));
    await expect(controller.finalizeUpload(body(), req)).rejects.toThrow('db down');
    expect(objects.has(FINAL)).toBe(false);
    expect(objects.has(DIRECT)).toBe(true);
  });

  it('never writes a scan-refused upload anywhere', async () => {
    fileScanner.scanOrThrow.mockRejectedValueOnce(new BadRequestException('infected'));
    await expect(controller.finalizeUpload(body(), req)).rejects.toThrow('infected');
    expect(storage.saveFileAt).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });

  describe('finalKeyForDirectUpload', () => {
    it('derives a stable key from the minted one', () => {
      expect(finalKeyForDirectUpload(DIRECT)).toBe(FINAL);
      expect(finalKeyForDirectUpload(DIRECT)).toBe(finalKeyForDirectUpload(DIRECT));
      const minted = directUploadKeyFor('Ramesh Kulkarni.PDF');
      expect(finalKeyForDirectUpload(minted)).toMatch(/^documents\/final\/[0-9a-f-]{36}\.pdf$/);
    });

    it.each([
      'uploads/2026/09/x.pdf',
      'documents/direct/../uploads/2026/09/someone-else.pdf',
      'documents/direct/not-a-uuid/a.pdf',
      'documents/direct/0b8a4a8e-6b7e-4a51-9d5c-3f1e2d4c5b6a/nested/a.pdf',
      'documents/direct/0b8a4a8e-6b7e-4a51-9d5c-3f1e2d4c5b6a/..',
      'documents/direct/0b8a4a8e-6b7e-4a51-9d5c-3f1e2d4c5b6a/',
    ])('refuses %s as not one of ours', (key) => {
      expect(() => finalKeyForDirectUpload(key)).toThrow(BadRequestException);
    });
  });
});
