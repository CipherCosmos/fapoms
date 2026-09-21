import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { lastValueFrom, of, throwError } from 'rxjs';
import { DocumentController } from './document.controller';
import { DiskUploadScanInterceptor } from './disk-upload-scan.interceptor';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { MAX_UPLOAD_BYTES } from './upload-validation';

/**
 * A DAY'S BATCH UPLOAD MUST NOT BE ABLE TO TAKE THE API DOWN.
 *
 * `POST /documents/upload-generated-batch` takes up to 100 files of up to 50 MB. It buffered all of
 * them in API memory (`memoryStorage()`), then scanned and encrypted each with another full-size
 * copy — up to 5 GB against an API container capped at 1.5 GB, so one large batch could get the API
 * killed for every user. The batch now lands on disk, is scanned one file at a time from disk, is
 * streamed to storage, and its temp files are deleted however the request ends.
 *
 * The scan is the part that must not quietly regress: the shared `FileScanInterceptor` scans
 * `file.buffer` and skips a file without one, so a disk-backed route guarded by it would accept
 * every file unscanned while looking guarded.
 */

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const interceptorsOf = (method: string): any[] =>
  Reflect.getMetadata(INTERCEPTORS_METADATA, (DocumentController.prototype as any)[method]) || [];

describe('the batch upload route', () => {
  it('writes the files to disk rather than holding the whole batch in memory', () => {
    const [MulterInterceptor] = interceptorsOf('uploadGeneratedBatch');
    const multer = new MulterInterceptor().multer;

    expect(multer.storage.constructor.name).toBe('DiskStorage');
    // The existing caps still apply at the streaming layer.
    expect(multer.limits).toEqual({ fileSize: MAX_UPLOAD_BYTES, files: 100 });
  });

  it('scans with the disk-reading interceptor, not the one that only sees in-memory buffers', () => {
    const interceptors = interceptorsOf('uploadGeneratedBatch');

    expect(interceptors[1]).toBe(DiskUploadScanInterceptor);
    expect(interceptors).not.toContain(FileScanInterceptor);
  });

  it('streams each file from disk to storage instead of reading it into memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'batch-spec-'));
    const path = join(dir, 'upload');
    writeFileSync(path, '%PDF-1.4 kolhapur');
    try {
      let stored: unknown;
      const storage = {
        saveFile: jest.fn(async (_name: string, content: unknown) => {
          const chunks: Buffer[] = [];
          for await (const chunk of content as Readable) chunks.push(Buffer.from(chunk));
          stored = Buffer.concat(chunks).toString();
          return 'key/1';
        }),
      };
      const documentService = {
        matchPdfsToBranches: jest.fn(async () => ({
          matches: [{ fileName: 'SOL001.pdf', projectBranchId: 'pb-1', branchName: 'Kolhapur Main' }],
          unmatched: [],
          branchesWithoutFile: [],
        })),
        resolveProjectBranchRegion: jest.fn(async () => 'WEST'),
        create: jest.fn(async () => ({ id: 'doc-1' })),
      };
      const controller = new DocumentController(
        documentService as any, storage as any,
        null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any,
        { assertRegionAllowedStaged: jest.fn(async () => undefined) } as any,
        null as any,
      );

      const res = await controller.uploadGeneratedBatch(
        [{ originalname: 'SOL001.pdf', mimetype: 'application/pdf', size: 17, path }],
        'proj-1', '2026-09-18', { user: { id: 'desk-1' } },
      );

      expect(res.data.created).toEqual([{ documentId: 'doc-1', fileName: 'SOL001.pdf', branchName: 'Kolhapur Main' }]);
      const content = storage.saveFile.mock.calls[0][1];
      expect(Buffer.isBuffer(content)).toBe(false);
      expect(content).toBeInstanceOf(Readable);
      expect(stored).toBe('%PDF-1.4 kolhapur');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DiskUploadScanInterceptor', () => {
  let dir: string;
  const saved = { host: process.env.CLAMAV_HOST, required: process.env.FILE_SCAN_REQUIRED };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'disk-scan-spec-'));
    // The always-on EICAR check is what these rely on, with no clamd to reach.
    delete process.env.CLAMAV_HOST;
    delete process.env.FILE_SCAN_REQUIRED;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.host !== undefined) process.env.CLAMAV_HOST = saved.host;
    if (saved.required !== undefined) process.env.FILE_SCAN_REQUIRED = saved.required;
  });

  const diskFile = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return { originalname: `${name}.pdf`, path };
  };
  const contextFor = (files: unknown[]) => ({ switchToHttp: () => ({ getRequest: () => ({ files }) }) }) as any;
  const interceptor = () => {
    const scanner = new FileScanService();
    jest.spyOn((scanner as any).logger, 'warn').mockImplementation(() => undefined);
    return new DiskUploadScanInterceptor(scanner);
  };
  /** The unlink after the handler is fire-and-forget; give it a moment. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('reads each file from disk to scan it, and refuses the whole batch on an infected one — deleting every file', async () => {
    const clean = diskFile('clean', '%PDF-1.4 fine');
    const infected = diskFile('infected', EICAR);
    const handle = jest.fn(() => of('filed'));

    await expect(interceptor().intercept(contextFor([clean, infected]), { handle })).rejects.toThrow(/malware scanning/);

    expect(handle).not.toHaveBeenCalled();
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(infected.path)).toBe(false);
  });

  it('keeps the files while the handler runs, and deletes them once it has answered', async () => {
    const file = diskFile('clean', '%PDF-1.4 fine');
    let presentDuringHandler = false;
    const handle = () => { presentDuringHandler = existsSync(file.path); return of('filed'); };

    const result = await lastValueFrom(await interceptor().intercept(contextFor([file]), { handle }));
    await settle();

    expect(result).toBe('filed');
    expect(presentDuringHandler).toBe(true);
    expect(existsSync(file.path)).toBe(false);
  });

  it('deletes the files when the handler (or a pipe before it) refuses the request', async () => {
    const file = diskFile('clean', '%PDF-1.4 fine');
    const handle = () => throwError(() => new Error('auditDate is required.'));

    await expect(lastValueFrom(await interceptor().intercept(contextFor([file]), { handle }))).rejects.toThrow(/auditDate/);
    await settle();

    expect(existsSync(file.path)).toBe(false);
  });

  it('refuses a file it can find neither on disk nor in memory, rather than passing it unscanned', async () => {
    const handle = jest.fn(() => of('filed'));

    await expect(
      interceptor().intercept(contextFor([{ originalname: 'ghost.pdf' }]), { handle }),
    ).rejects.toThrow(/could not be scanned/);
    expect(handle).not.toHaveBeenCalled();
  });
});
