import { RECLAIM_AFTER_MS } from '../../infrastructure/background-jobs/background-job.store';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { CustomerMasterStatus, type BackgroundJobStatus } from '@fapoms/shared';
import { BackgroundJobEntity } from '../../infrastructure/background-jobs/background-job.entity';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobRunner } from '../../infrastructure/background-jobs/background-job.runner';
import { DiskUploadScanInterceptor } from '../document/disk-upload-scan.interceptor';
import { CustomerMasterController } from './customer-master.controller';
import {
  CUSTOMER_MASTER_IMPORT_KIND,
  CUSTOMER_MASTER_INTERRUPTED,
  CustomerMasterImportJob,
} from './customer-master-import.job';
import { RECONCILE_STAGE, type CustomerMasterReconciliationReportDto } from './customer-master.service';

/**
 * THE CLIENT'S DAILY FILE IS ACCEPTED AT ONCE AND RECONCILED IN THE BACKGROUND — ONCE.
 *
 * `POST /customer-master/upload` used to reconcile inside the request (then on a Bull queue whose
 * progress lived only in the browser tab). It now stores the file on a `background_jobs` row and
 * answers 202; `CustomerMasterImportJob` reconciles it in the worker. These pin: the route hands the
 * foundation the file, the project scope and the parameters; a wrong upload is refused before
 * anything is stored; the run reports real progress, keeps its OWN copy of the file for the version,
 * and succeeds with the report the Daily Run panel draws; and a run whose worker died is FAILED with
 * the sentence that sends the operator to the versions list — never run a second time, because a
 * second run registers the file as a second version.
 *
 * The foundation is real (`BackgroundJobsService`, `BackgroundJobRunner`); the store and the queue
 * are in-memory stand-ins that keep its rules (conditional transitions, one row per dedupe key).
 */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class FakeStore {
  rows = new Map<string, BackgroundJobEntity>();
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
      inputObjects: null, runnerQueue: null, ...values,
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
  progressWrites: any[] = [];
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

const report = (over: Partial<CustomerMasterReconciliationReportDto> = {}): CustomerMasterReconciliationReportDto => ({
  versionId: 'v-3', projectId: PROJECT, versionNumber: 3, totalRowsProcessed: 1200, uniqueAccountsCount: 1180,
  duplicateAccountsCount: 20, unmappedBranchCodesCount: 1, status: CustomerMasterStatus.RECONCILED, accepted: true,
  blockReason: null, unmatchedCount: 2,
  unmatchedAccounts: [{ accountNumber: 'A1', solId: '9999', reason: 'SOL ID "9999" is not in the system' }],
  coveredBranchCount: 14, auditDate: '2026-09-25', recommendation: 'ok', ...over,
});

const sheet = (name = 'client.xlsx', mimeType = XLSX) =>
  ({ buffer: Buffer.from('PK\u0003\u0004 [Content_Types].xml xl/workbook'), originalName: name, mimeType, size: 40 });
const actor = { userId: ALICE, roleNames: ['DESK'], displayName: 'alice' };

let store: FakeStore;
let storage: FakeStorage;
let queue: { add: jest.Mock };
let registry: BackgroundJobRegistry;
let service: BackgroundJobsService;
let runner: BackgroundJobRunner;
let customerMaster: { uploadAndReconcile: jest.Mock; assertUploadTarget: jest.Mock };

beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

beforeEach(() => {
  store = new FakeStore();
  storage = new FakeStorage();
  queue = { add: jest.fn(async (_name: string, _data: any, opts: any) => ({ id: opts.jobId })) };
  registry = new BackgroundJobRegistry();
  service = new BackgroundJobsService(store as any, registry, queue as any, storage as any, { publish: jest.fn() } as any);
  runner = new BackgroundJobRunner(store as any, registry, service, storage as any);
  customerMaster = {
    assertUploadTarget: jest.fn(async () => undefined),
    uploadAndReconcile: jest.fn(async (...args: any[]) => {
      const onProgress = args[6];
      await onProgress?.(0, 1200, RECONCILE_STAGE.MATCHING);
      await onProgress?.(1200, 1200, RECONCILE_STAGE.MATCHING);
      await onProgress?.(1180, 1180, RECONCILE_STAGE.SAVING);
      return report();
    }),
  };
  new CustomerMasterImportJob(registry, customerMaster as any, storage as any).onModuleInit();
});

const start = (params: Record<string, unknown> = { projectId: PROJECT, auditDate: '2026-09-25' }, file = sheet()) =>
  service.create({ kind: CUSTOMER_MASTER_IMPORT_KIND, actor, regions: null, scope: { type: 'PROJECT', id: PROJECT }, params, file });
const work = (id: string) => runner.run({ id: store.rows.get(id)!.bullJobId!, data: { backgroundJobId: id } } as any);

describe('POST /customer-master/upload', () => {
  const upload = (CustomerMasterController.prototype as any).upload;

  it('answers 202, and the file is on disk and scanned before the handler runs', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, upload)).toBe(202);
    const [Multer, Scan] = Reflect.getMetadata(INTERCEPTORS_METADATA, upload);
    expect(new Multer().multer.storage.constructor.name).toBe('DiskStorage');
    expect(Scan).toBe(DiskUploadScanInterceptor);
  });

  it('hands the foundation the file (by its temp path), the project scope and the parameters', async () => {
    const jobs = { create: jest.fn(async () => ({ job: { id: 'j-1' }, deduplicated: false })) };
    const controller = new CustomerMasterController(null as any, jobs as any);
    const file = { path: '/tmp/fapoms-upload-batches/x', originalname: 'client.xlsx', mimetype: XLSX, size: 40 } as any;

    const out = await controller.upload(file, { user: { id: ALICE, roles: ['DESK'] }, body: {} }, PROJECT, '2026-09-25', { clientId: undefined } as any);

    expect(out).toEqual({ job: { id: 'j-1' }, deduplicated: false });
    expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CUSTOMER_MASTER_IMPORT',
      scope: { type: 'PROJECT', id: PROJECT },
      params: { projectId: PROJECT, auditDate: '2026-09-25' },
      file: { path: file.path, buffer: undefined, originalName: 'client.xlsx', mimeType: XLSX, size: 40 },
      actor: expect.objectContaining({ userId: ALICE }),
      regions: null,
      globalScope: { clientId: undefined },
    }));
  });

  it('reads the parameters from the multipart params JSON when the query does not carry them', async () => {
    const jobs = { create: jest.fn(async () => ({ job: { id: 'j-1' }, deduplicated: false })) };
    const controller = new CustomerMasterController(null as any, jobs as any);
    const body = { params: JSON.stringify({ projectId: PROJECT, auditDate: '2026-09-25' }) };

    await controller.upload(undefined, { user: { id: ALICE }, body }, undefined, undefined, undefined);

    expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining({ params: { projectId: PROJECT, auditDate: '2026-09-25' } }));
  });
});

describe('prepare — a bad upload is still an immediate refusal, and nothing is stored', () => {
  it.each([
    ['a PDF', { projectId: PROJECT, auditDate: '2026-09-25' }, sheet('scan.pdf', 'application/pdf')],
    ['no project', { auditDate: '2026-09-25' }, sheet()],
    ['a date that is not one', { projectId: PROJECT, auditDate: '25/09/2026' }, sheet()],
  ])('refuses %s with a 400', async (_label, params, file) => {
    await expect(start(params, file)).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('refuses a project that does not exist, or another client\'s, as the service decides', async () => {
    customerMaster.assertUploadTarget.mockRejectedValueOnce(new NotFoundException('Project not found'));
    await expect(start()).rejects.toBeInstanceOf(NotFoundException);
    customerMaster.assertUploadTarget.mockRejectedValueOnce(new ForbiddenException('different client'));
    await expect(start()).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.saveFile).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });
});

describe('the run', () => {
  it('reconciles with real progress, keeps its own copy for the version, and succeeds with the panel\'s report', async () => {
    const { job } = await start();
    const inputKey = store.rows.get(job.id)!.inputObjectKey!;

    expect(await work(job.id)).toBe('SUCCEEDED');

    const [projectId, fileName, savedPath, buffer, userId, auditDate] = customerMaster.uploadAndReconcile.mock.calls[0];
    expect({ projectId, fileName, userId, auditDate }).toEqual({ projectId: PROJECT, fileName: 'client.xlsx', userId: ALICE, auditDate: '2026-09-25' });
    // The version records a key of its own — never the job's input, which retention deletes.
    expect(savedPath).not.toBe(inputKey);
    expect(storage.objects.get(savedPath)).toEqual(buffer);
    expect(storage.saveFile).toHaveBeenLastCalledWith('client.xlsx', buffer, XLSX);

    expect(store.progressWrites.map((p) => p.stage)).toEqual(
      expect.arrayContaining(['Reading the file', RECONCILE_STAGE.MATCHING, RECONCILE_STAGE.SAVING]),
    );
    expect(store.progressWrites).toContainEqual(expect.objectContaining({ stage: RECONCILE_STAGE.MATCHING, processed: 1200, total: 1200 }));

    const row = store.rows.get(job.id)!;
    expect(row.result).toEqual({
      summary: 'Accepted as v3: 1,180 accounts, 2 rows matched no branch.',
      counts: { rows: 1200, accounts: 1180, duplicates: 20, unmatched: 2, branches: 14 },
      details: report(),
    });
  });

  it('a rejected batch is a finished job whose report says so — not a failed one', async () => {
    customerMaster.uploadAndReconcile.mockResolvedValueOnce(report({ accepted: false, status: CustomerMasterStatus.REJECTED, blockReason: 'Too many exceptions.' }));
    const { job } = await start();

    expect(await work(job.id)).toBe('SUCCEEDED');
    expect(store.rows.get(job.id)!.result).toMatchObject({ summary: 'Rejected. Too many exceptions.', details: { accepted: false } });
  });

  it('a reconciliation that throws leaves no orphan copy behind, and the job is FAILED with its sentence', async () => {
    customerMaster.uploadAndReconcile.mockRejectedValueOnce(new NotFoundException('Project was not found.'));
    const { job } = await start();
    const inputKey = store.rows.get(job.id)!.inputObjectKey!;

    expect(await work(job.id)).toBe('FAILED');
    expect(store.rows.get(job.id)!.error).toBe('Project was not found.');
    expect([...storage.objects.keys()]).toEqual([inputKey]);
  });

  it('a run whose worker died is FAILED with the versions-list sentence, and never run again', async () => {
    const { job } = await start();
    await store.claim(job.id, null); // the first worker got this far, then died
    // …and nothing has touched the row since: a RUNNING row still being heartbeat is a live run,
    // which the runner leaves alone rather than failing (`RECLAIM_AFTER_MS`).
    store.rows.get(job.id)!.updatedAt = new Date(Date.now() - RECLAIM_AFTER_MS - 1_000);

    expect(await work(job.id)).toBe('interrupted');

    expect(customerMaster.uploadAndReconcile).not.toHaveBeenCalled();
    expect(store.rows.get(job.id)!).toMatchObject({ status: 'FAILED', error: CUSTOMER_MASTER_INTERRUPTED });
    expect(CUSTOMER_MASTER_INTERRUPTED).toMatch(/was not run again automatically because reconciling the same file twice registers it twice/);
  });

  it('runs one at a time, system-wide, and never re-runs', () => {
    const definition = registry.require(CUSTOMER_MASTER_IMPORT_KIND);
    expect(definition).toMatchObject({ input: 'required', idempotent: false, exclusive: 'kind', interruptedMessage: CUSTOMER_MASTER_INTERRUPTED });
    expect(definition.start).toBeUndefined(); // only its own route, with its own guards, starts it
  });
});
