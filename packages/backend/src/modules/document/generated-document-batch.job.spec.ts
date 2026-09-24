import { RECLAIM_AFTER_MS } from '../../infrastructure/background-jobs/background-job.store';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { DocumentType, type BackgroundJobStatus } from '@fapoms/shared';
import { BackgroundJobEntity } from '../../infrastructure/background-jobs/background-job.entity';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobRunner } from '../../infrastructure/background-jobs/background-job.runner';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import {
  GENERATED_BATCH_INTERRUPTED,
  GENERATED_DOCUMENT_BATCH_KIND,
  GeneratedDocumentBatchJob,
  type GeneratedBatchOutcome,
} from './generated-document-batch.job';

/**
 * A DAY'S PACKETS ARE STORED AT ONCE AND FILED IN THE BACKGROUND — EVERY ONE SCANNED FIRST.
 *
 * `POST /documents/upload-generated-batch` now only stores the set (each file under its own key) and
 * answers 202; `GeneratedDocumentBatchJob` files it in the worker. Because the request no longer
 * scans, the worker is the ONLY scan these bytes get — so these pin that every packet is scanned
 * (malware + the byte-level content gate) before it is stored as a document, that one infected or
 * refused packet is a line in `failed` while the rest are filed, that unplaceable files are listed
 * rather than guessed at, that each document keeps a storage key of its own, and that a run whose
 * worker died is failed rather than filing the same packets twice.
 *
 * The scanner is the real `FileScanService` (its always-on EICAR check needs no clamd); the
 * foundation is real; the store, queue and storage are in-memory.
 */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

class FakeStore {
  rows = new Map<string, BackgroundJobEntity>();
  progressWrites: any[] = [];
  private clone(r?: BackgroundJobEntity | null) { return r ? ({ ...r, progress: { ...r.progress } } as BackgroundJobEntity) : null; }
  async findById(id: string) { return this.clone(this.rows.get(id)); }
  async findOpenByDedupe(key: string) {
    return this.clone([...this.rows.values()].find((r) => r.dedupeKey === key && ['QUEUED', 'RUNNING', 'AWAITING_REVIEW'].includes(r.status)));
  }
  async insert(values: Partial<BackgroundJobEntity>) {
    const now = new Date();
    const row = {
      id: randomUUID(), attempts: 0, bullJobId: null, cancelRequestedAt: null, result: null, resultObjectKey: null,
      error: null, exclusiveKey: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
      inputObjects: null, inputObjectKey: null, runnerQueue: null, ...values,
    } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: this.clone(row)!, inserted: true };
  }
  async setBullJobId(id: string, bullJobId: string) { this.touch(id, { bullJobId }); }
  async claim(id: string, exclusiveKey: string | null) {
    const row = this.rows.get(id);
    if (!row || !['QUEUED', 'RUNNING'].includes(row.status)) return null;
    this.touch(id, { status: 'RUNNING', exclusiveKey, attempts: row.attempts + 1, startedAt: new Date() });
    return this.findById(id);
  }
  async transition(id: string, from: BackgroundJobStatus[], patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return null;
    this.touch(id, patch);
    return this.findById(id);
  }
  async writeProgress(id: string, progress: any) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'RUNNING') return false;
    this.progressWrites.push(progress);
    this.touch(id, { progress });
    return true;
  }
  async patch(id: string, patch: Partial<BackgroundJobEntity>) { this.touch(id, patch); }
  async cancelRequestedAt(id: string) { return this.rows.get(id)?.cancelRequestedAt ?? null; }
  private touch(id: string, patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch, { updatedAt: new Date() });
  }
}

class FakeStorage {
  objects = new Map<string, Buffer>();
  saveFile = jest.fn(async (name: string, content: Buffer | Readable) => {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(content)) chunks.push(content);
    else for await (const c of content) chunks.push(Buffer.from(c));
    const key = `k/${randomUUID()}/${name}`;
    this.objects.set(key, Buffer.concat(chunks));
    return key;
  });
  getFileStream = jest.fn(async (key: string) => Readable.from(this.objects.get(key) ?? Buffer.alloc(0)));
  deleteFile = jest.fn(async (key: string) => { this.objects.delete(key); });
}

const pdf = (name: string, body = `%PDF-1.4 ${name}\n%%EOF`) =>
  ({ buffer: Buffer.from(body), originalName: name, mimeType: 'application/pdf', size: Buffer.byteLength(body) });
const actor = { userId: ALICE, roleNames: ['DESK'], displayName: 'alice' };

let store: FakeStore;
let storage: FakeStorage;
let registry: BackgroundJobRegistry;
let service: BackgroundJobsService;
let runner: BackgroundJobRunner;
let scanner: FileScanService;
let regionGuard: { assertRegionAllowedStaged: jest.Mock };
let documentService: {
  matchPdfsToBranches: jest.Mock;
  resolveProjectBranchRegion: jest.Mock;
  create: jest.Mock;
};
const savedEnv = { host: process.env.CLAMAV_HOST, required: process.env.FILE_SCAN_REQUIRED };

beforeAll(() => {
  Logger.overrideLogger(false);
  delete process.env.CLAMAV_HOST;
  delete process.env.FILE_SCAN_REQUIRED;
});
afterAll(() => {
  Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']);
  if (savedEnv.host !== undefined) process.env.CLAMAV_HOST = savedEnv.host;
  if (savedEnv.required !== undefined) process.env.FILE_SCAN_REQUIRED = savedEnv.required;
});

/** Files named after a branch code match it; `mystery.pdf` matches nothing. */
const BRANCHES: Record<string, { projectBranchId: string; branchName: string }> = {
  'SOL001.pdf': { projectBranchId: 'pb-1', branchName: 'Kolhapur Main' },
  'SOL002.pdf': { projectBranchId: 'pb-2', branchName: 'Sangli' },
  'SOL003.pdf': { projectBranchId: 'pb-3', branchName: 'Satara' },
};

beforeEach(() => {
  store = new FakeStore();
  storage = new FakeStorage();
  registry = new BackgroundJobRegistry();
  const queue = { add: jest.fn(async (_n: string, _d: any, opts: any) => ({ id: opts.jobId })) };
  service = new BackgroundJobsService(store as any, registry, queue as any, storage as any, { publish: jest.fn() } as any);
  runner = new BackgroundJobRunner(store as any, registry, service, storage as any);
  scanner = new FileScanService();
  jest.spyOn((scanner as any).logger, 'warn').mockImplementation(() => undefined);
  regionGuard = { assertRegionAllowedStaged: jest.fn(async () => undefined) };
  let docs = 0;
  documentService = {
    matchPdfsToBranches: jest.fn(async (_p: string, _d: string, names: string[]) => ({
      matches: names.filter((n) => BRANCHES[n]).map((n) => ({ fileName: n, ...BRANCHES[n], solId: n.slice(0, 6), matchedOn: 'SOL' })),
      unmatched: names.filter((n) => !BRANCHES[n]).map((n) => ({ fileName: n, reason: 'No scheduled branch matches this filename.' })),
      branchesWithoutFile: [{ projectBranchId: 'pb-9', branchName: 'Miraj', solId: 'SOL009' }],
    })),
    resolveProjectBranchRegion: jest.fn(async () => 'WEST'),
    create: jest.fn(async () => ({ id: `doc-${++docs}` })),
  };
  new GeneratedDocumentBatchJob(registry, documentService as any, scanner, regionGuard as any, storage as any).onModuleInit();
});

const start = (files: ReturnType<typeof pdf>[], params: Record<string, unknown> = { projectId: PROJECT, auditDate: '2026-09-25', customerMasterVersionId: null }) =>
  service.create({ kind: GENERATED_DOCUMENT_BATCH_KIND, actor, regions: ['WEST'], scope: { type: 'PROJECT', id: PROJECT }, params, files });
const work = (id: string) => runner.run({ id: store.rows.get(id)!.bullJobId!, data: { backgroundJobId: id } } as any);
const details = (id: string) => store.rows.get(id)!.result!.details as GeneratedBatchOutcome;

describe('accepting a batch', () => {
  it('stores every file on its own before answering, files nothing yet, and says how many there are', async () => {
    const { job } = await start([pdf('SOL001.pdf'), pdf('SOL002.pdf')]);

    const row = store.rows.get(job.id)!;
    expect(row.status).toBe('QUEUED');
    expect(row.inputObjects!.map((o) => o.fileName)).toEqual(['SOL001.pdf', 'SOL002.pdf']);
    expect(row.progress.total).toBe(2);
    expect(job.title).toBe('2 audit packets for 2026-09-25');
    expect(documentService.create).not.toHaveBeenCalled();
  });

  it('refuses bad parameters before anything is stored', async () => {
    await expect(start([pdf('SOL001.pdf')], { projectId: PROJECT })).rejects.toThrow(/auditDate is required/);
    await expect(start([pdf('SOL001.pdf')], { projectId: PROJECT, auditDate: 'tomorrow' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(start([pdf('SOL001.pdf')], { projectId: 'x', auditDate: '2026-09-25' })).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });
});

describe('filing a batch', () => {
  it('scans each packet before storing it, files the matched ones under keys of their own, and lists the rest', async () => {
    const scan = jest.spyOn(scanner, 'scanOrThrow');
    const { job } = await start([pdf('SOL001.pdf'), pdf('mystery.pdf'), pdf('SOL002.pdf')]);
    const inputKeys = store.rows.get(job.id)!.inputObjects!.map((o) => o.key);
    storage.saveFile.mockClear();

    expect(await work(job.id)).toBe('SUCCEEDED');

    // Every filed packet was scanned, and scanned BEFORE its bytes were stored.
    expect(scan.mock.calls.map((c) => c[1])).toEqual(['SOL001.pdf', 'SOL002.pdf']);
    expect(storage.saveFile).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(scan.mock.invocationCallOrder[i]).toBeLessThan(storage.saveFile.mock.invocationCallOrder[i]);
    }

    const created = documentService.create.mock.calls.map(([dto]) => dto);
    expect(created).toEqual([
      expect.objectContaining({ assessmentId: 'pb-1', fileName: 'SOL001.pdf', type: DocumentType.PRE_FIELD_AUDIT_PDF, mimeType: 'application/pdf' }),
      expect.objectContaining({ assessmentId: 'pb-2', fileName: 'SOL002.pdf', type: DocumentType.PRE_FIELD_AUDIT_PDF }),
    ]);
    // A document never records the job's input key (retention deletes those after 30 days).
    for (const dto of created) {
      expect(inputKeys).not.toContain(dto.filePath);
      expect(storage.objects.get(dto.filePath)!.toString()).toContain(dto.fileName);
      expect(dto.integrity.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(documentService.create.mock.calls[0][1]).toBe(ALICE);

    const row = store.rows.get(job.id)!;
    expect(row.result!.summary).toBe('Filed 2 of 3 packet(s). 1 could not be matched to a branch. 1 scheduled branch(es) still have no packet.');
    expect(row.result!.counts).toEqual({ files: 3, created: 2, unmatched: 1, failed: 0, branchesWithoutFile: 1 });
    expect(details(job.id)).toMatchObject({
      auditDate: '2026-09-25',
      created: [
        { documentId: 'doc-1', fileName: 'SOL001.pdf', branchName: 'Kolhapur Main' },
        { documentId: 'doc-2', fileName: 'SOL002.pdf', branchName: 'Sangli' },
      ],
      unmatched: [{ fileName: 'mystery.pdf', reason: 'No scheduled branch matches this filename.' }],
      failed: [],
      branchesWithoutFile: [{ projectBranchId: 'pb-9', branchName: 'Miraj', solId: 'SOL009' }],
    });
  });

  it('an infected packet is refused and never stored — the rest of the batch is still filed', async () => {
    const { job } = await start([pdf('SOL001.pdf'), pdf('SOL002.pdf', EICAR), pdf('SOL003.pdf')]);
    const before = storage.objects.size;

    expect(await work(job.id)).toBe('SUCCEEDED');

    expect(details(job.id).created.map((c) => c.fileName)).toEqual(['SOL001.pdf', 'SOL003.pdf']);
    expect(details(job.id).failed).toEqual([{ fileName: 'SOL002.pdf', reason: expect.stringMatching(/malware scanning/) }]);
    expect(documentService.create).toHaveBeenCalledTimes(2);
    expect(storage.objects.size).toBe(before + 2);
    expect([...storage.objects.values()].filter((b) => b.toString().includes('EICAR'))).toHaveLength(1); // only the job's input
  });

  it('a file whose bytes are not what it claims (the content gate) is refused the same way', async () => {
    const { job } = await start([pdf('SOL001.pdf', 'MZ\u0090\u0000 this is an executable'), pdf('SOL002.pdf')]);

    await work(job.id);

    expect(details(job.id).failed).toEqual([{ fileName: 'SOL001.pdf', reason: expect.any(String) }]);
    expect(details(job.id).created.map((c) => c.fileName)).toEqual(['SOL002.pdf']);
  });

  it('a document that cannot be recorded leaves no orphan copy, and is a line in failed', async () => {
    documentService.create.mockRejectedValueOnce(new Error('Branch is archived.'));
    const { job } = await start([pdf('SOL001.pdf')]);
    const before = storage.objects.size;

    await work(job.id);

    expect(details(job.id).failed).toEqual([{ fileName: 'SOL001.pdf', reason: 'Branch is archived.' }]);
    expect(storage.objects.size).toBe(before);
  });

  it('reports progress per file', async () => {
    const { job } = await start([pdf('mystery.pdf'), pdf('SOL001.pdf'), pdf('SOL002.pdf')]);

    await work(job.id);

    const filing = store.progressWrites.filter((p) => p.stage === 'Filing packets');
    expect(filing[0]).toMatchObject({ processed: 1, total: 3 });
    expect(filing[filing.length - 1]).toMatchObject({ processed: 3, total: 3 });
  });

  it('re-checks the region of every matched branch against the regions captured with the job, before filing any', async () => {
    regionGuard.assertRegionAllowedStaged
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ForbiddenException('That record belongs to a region your account is not assigned to.'));
    const { job } = await start([pdf('SOL001.pdf'), pdf('SOL002.pdf')]);

    expect(await work(job.id)).toBe('FAILED');

    expect(regionGuard.assertRegionAllowedStaged).toHaveBeenCalledWith('WEST', { regions: ['WEST'] }, 'document:uploadGeneratedBatch');
    expect(store.rows.get(job.id)!.error).toMatch(/region your account is not assigned to/);
    expect(documentService.create).not.toHaveBeenCalled();
  });

  it('a run whose worker died is FAILED with the board sentence, and never files the packets twice', async () => {
    const { job } = await start([pdf('SOL001.pdf')]);
    await store.claim(job.id, null); // the first worker got this far, then died
    // …and nothing has touched the row since: a RUNNING row still being heartbeat is a live run,
    // which the runner leaves alone rather than failing (`RECLAIM_AFTER_MS`).
    store.rows.get(job.id)!.updatedAt = new Date(Date.now() - RECLAIM_AFTER_MS - 1_000);

    expect(await work(job.id)).toBe('interrupted');

    expect(documentService.create).not.toHaveBeenCalled();
    expect(store.rows.get(job.id)!).toMatchObject({ status: 'FAILED', error: GENERATED_BATCH_INTERRUPTED });
  });

  it('is a several-file kind, one batch per project at a time, never re-run, started only by its own route', () => {
    expect(registry.require(GENERATED_DOCUMENT_BATCH_KIND)).toMatchObject({
      input: 'files', idempotent: false, exclusive: 'scope', interruptedMessage: GENERATED_BATCH_INTERRUPTED,
    });
    expect(registry.require(GENERATED_DOCUMENT_BATCH_KIND).start).toBeUndefined();
  });
});
