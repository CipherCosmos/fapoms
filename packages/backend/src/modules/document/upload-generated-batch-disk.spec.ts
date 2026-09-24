import { HTTP_CODE_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { lastValueFrom, of, throwError } from 'rxjs';
import { DocumentController } from './document.controller';
import { DiskUploadScanInterceptor } from './disk-upload-scan.interceptor';
import { DiskUploadCleanupInterceptor } from './disk-upload-cleanup.interceptor';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { MAX_UPLOAD_BYTES } from './upload-validation';

/**
 * A DAY'S BATCH UPLOAD MUST NOT BE ABLE TO TAKE THE API DOWN — AND MUST ANSWER AT ONCE.
 *
 * `POST /documents/upload-generated-batch` takes up to 100 files of up to 50 MB. It buffered all of
 * them in API memory (`memoryStorage()`) — up to 5 GB against an API container capped at 1.5 GB. The
 * batch lands on disk, is streamed to storage one file at a time, and its temp files are deleted
 * however the request ends. Since the move to a background job the route only STORES the set and
 * answers 202 with the job; the scan and the filing happen in the worker
 * (`generated-document-batch.job.spec.ts`), so the in-request scan was replaced by the cleanup-only
 * interceptor — `upload-scan-parity.spec.ts` pins that this route alone may do that, and that the
 * job scans every file.
 */

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

  it('deletes the temp files with the cleanup interceptor, and never pairs disk files with the buffer-only scan', () => {
    const interceptors = interceptorsOf('uploadGeneratedBatch');

    expect(interceptors[1]).toBe(DiskUploadCleanupInterceptor);
    expect(interceptors).not.toContain(FileScanInterceptor);
  });

  it('answers 202', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, DocumentController.prototype.uploadGeneratedBatch)).toBe(202);
  });

  const build = () => {
    const documentService = {
      matchPdfsToBranches: jest.fn(async () => ({
        matches: [{ fileName: 'SOL001.pdf', projectBranchId: 'pb-1', branchName: 'Kolhapur Main' }],
        unmatched: [],
        branchesWithoutFile: [],
      })),
      resolveProjectBranchRegion: jest.fn(async () => 'WEST'),
      create: jest.fn(async () => ({ id: 'doc-1' })),
    };
    const regionGuard = { assertRegionAllowedStaged: jest.fn(async () => undefined) };
    const backgroundJobs = { create: jest.fn(async () => ({ job: { id: 'job-1' }, deduplicated: false })) };
    const storage = { saveFile: jest.fn() };
    const controller = new DocumentController(
      documentService as any, storage as any,
      null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any,
      regionGuard as any,
      null as any,
      backgroundJobs as any,
    );
    return { controller, documentService, regionGuard, backgroundJobs, storage };
  };
  const PROJECT = '11111111-1111-4111-8111-111111111111';
  const diskFile = { originalname: 'SOL001.pdf', mimetype: 'application/pdf', size: 17, path: '/tmp/fapoms-upload-batches/abc' } as any;

  it('stores the set as a job — the files by their temp path, never read into memory — and files nothing itself', async () => {
    const { controller, documentService, backgroundJobs, storage } = build();

    const res = await controller.uploadGeneratedBatch(
      [diskFile], { user: { id: 'desk-1', roles: ['DESK'] }, body: {} }, PROJECT, '2026-09-18', undefined, undefined,
    );

    expect(res).toEqual({ job: { id: 'job-1' }, deduplicated: false });
    expect(backgroundJobs.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'GENERATED_DOCUMENT_BATCH',
      scope: { type: 'PROJECT', id: PROJECT },
      params: { projectId: PROJECT, auditDate: '2026-09-18', customerMasterVersionId: null },
      files: [{ path: diskFile.path, buffer: undefined, originalName: 'SOL001.pdf', mimeType: 'application/pdf', size: 17 }],
      actor: expect.objectContaining({ userId: 'desk-1' }),
    }));
    expect(documentService.create).not.toHaveBeenCalled();
    expect(storage.saveFile).not.toHaveBeenCalled();
  });

  it('takes its parameters from the multipart params JSON too (the background-job upload sends them there)', async () => {
    const { controller, backgroundJobs } = build();
    const body = { params: JSON.stringify({ projectId: PROJECT, auditDate: '2026-09-18', customerMasterVersionId: '22222222-2222-4222-8222-222222222222' }) };

    await controller.uploadGeneratedBatch([diskFile], { user: { id: 'desk-1' }, body }, undefined, undefined, undefined, undefined);

    expect(backgroundJobs.create).toHaveBeenCalledWith(expect.objectContaining({
      params: { projectId: PROJECT, auditDate: '2026-09-18', customerMasterVersionId: '22222222-2222-4222-8222-222222222222' },
    }));
  });

  it('refuses the whole upload, storing nothing, when a matched branch is outside the caller\'s region', async () => {
    const { controller, regionGuard, backgroundJobs } = build();
    regionGuard.assertRegionAllowedStaged.mockRejectedValueOnce(new ForbiddenException('outside your region'));

    await expect(controller.uploadGeneratedBatch([diskFile], { user: { id: 'desk-1' }, body: {} }, PROJECT, '2026-09-18'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(backgroundJobs.create).not.toHaveBeenCalled();
  });

  it('refuses a missing date or project before anything is stored', async () => {
    const { controller, backgroundJobs } = build();
    await expect(controller.uploadGeneratedBatch([diskFile], { user: { id: 'u' }, body: {} }, PROJECT, undefined))
      .rejects.toThrow(/auditDate is required/);
    await expect(controller.uploadGeneratedBatch([diskFile], { user: { id: 'u' }, body: {} }, 'nope', '2026-09-18'))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.uploadGeneratedBatch([], { user: { id: 'u' }, body: {} }, PROJECT, '2026-09-18'))
      .rejects.toThrow(/No files received/);
    expect(backgroundJobs.create).not.toHaveBeenCalled();
  });
});

describe('DiskUploadCleanupInterceptor', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'disk-cleanup-spec-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const diskFile = (name: string) => {
    const path = join(dir, name);
    writeFileSync(path, '%PDF-1.4 fine\n%%EOF');
    return { originalname: `${name}.pdf`, path };
  };
  const contextFor = (files: unknown[]) => ({ switchToHttp: () => ({ getRequest: () => ({ files }) }) }) as any;
  const gone = async (p: string) => {
    for (let i = 0; i < 100 && existsSync(p); i++) await new Promise((r) => setTimeout(r, 20));
    return !existsSync(p);
  };

  it('keeps the files while the handler stores them, and deletes them once it has answered', async () => {
    const file = diskFile('a');
    let presentDuringHandler = false;
    const handle = () => { presentDuringHandler = existsSync(file.path); return of('stored'); };

    const result = await lastValueFrom(new DiskUploadCleanupInterceptor().intercept(contextFor([file]), { handle }));

    expect(result).toBe('stored');
    expect(presentDuringHandler).toBe(true);
    expect(await gone(file.path)).toBe(true);
  });

  it('deletes the files when the handler refuses the request', async () => {
    const file = diskFile('b');
    const handle = () => throwError(() => new Error('auditDate is required.'));

    await expect(lastValueFrom(new DiskUploadCleanupInterceptor().intercept(contextFor([file]), { handle }))).rejects.toThrow(/auditDate/);
    expect(await gone(file.path)).toBe(true);
  });
});

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

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
  /** Deletion is fire-and-forget; a fixed wait flaked on a loaded CI runner, so wait for the fact. */
  const gone = async (p: string) => {
    for (let i = 0; i < 100 && existsSync(p); i++) await new Promise((r) => setTimeout(r, 20));
    return !existsSync(p);
  };

  it('reads each file from disk to scan it, and refuses the whole batch on an infected one — deleting every file', async () => {
    const clean = diskFile('clean', '%PDF-1.4 fine\n%%EOF');
    const infected = diskFile('infected', EICAR);
    const handle = jest.fn(() => of('filed'));

    await expect(interceptor().intercept(contextFor([clean, infected]), { handle })).rejects.toThrow(/malware scanning/);

    expect(handle).not.toHaveBeenCalled();
    expect(await gone(clean.path)).toBe(true);
    expect(await gone(infected.path)).toBe(true);
  });

  it('keeps the files while the handler runs, and deletes them once it has answered', async () => {
    const file = diskFile('clean', '%PDF-1.4 fine\n%%EOF');
    let presentDuringHandler = false;
    const handle = () => { presentDuringHandler = existsSync(file.path); return of('filed'); };

    const result = await lastValueFrom(await interceptor().intercept(contextFor([file]), { handle }));
    await settle();

    expect(result).toBe('filed');
    expect(presentDuringHandler).toBe(true);
    expect(await gone(file.path)).toBe(true);
  });

  it('deletes the files when the handler (or a pipe before it) refuses the request', async () => {
    const file = diskFile('clean', '%PDF-1.4 fine\n%%EOF');
    const handle = () => throwError(() => new Error('auditDate is required.'));

    await expect(lastValueFrom(await interceptor().intercept(contextFor([file]), { handle }))).rejects.toThrow(/auditDate/);
    await settle();

    expect(await gone(file.path)).toBe(true);
  });

  it('refuses a file it can find neither on disk nor in memory, rather than passing it unscanned', async () => {
    const handle = jest.fn(() => of('filed'));

    await expect(
      interceptor().intercept(contextFor([{ originalname: 'ghost.pdf' }]), { handle }),
    ).rejects.toThrow(/could not be scanned/);
    expect(handle).not.toHaveBeenCalled();
  });
});
