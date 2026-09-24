import { randomUUID } from 'crypto';
import { Logger, NotFoundException } from '@nestjs/common';

import { ReportJobsService, type ReportRequester } from './report-jobs.service';
import { ReportJobsWorker } from './report-jobs.worker';
import { ReportFileStore } from './report-file.store';
import {
  REPORT_JOB,
  REPORT_QUEUE,
  REPORT_COMPLETED_RETENTION,
  REPORT_RESULT_TTL_SECONDS,
  MAX_EXPORT_BYTES,
} from './report-jobs.contract';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import type { BackgroundJobEntity } from '../../infrastructure/background-jobs/background-job.entity';

/**
 * The rules of the real row store that `enqueueTracked` and the tracker rely on (conditional
 * transitions), without Postgres — the same shape as the foundation's own tracked spec.
 */
class FakeRowStore {
  rows = new Map<string, BackgroundJobEntity>();
  async insert(values: Partial<BackgroundJobEntity>) {
    const now = new Date();
    const row = {
      id: randomUUID(), attempts: 0, bullJobId: null, result: null, resultObjectKey: null, resultFileName: null,
      resultMimeType: null, error: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
      ...values,
    } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: { ...row }, inserted: true };
  }
  async findById(id: string) { const r = this.rows.get(id); return r ? { ...r } : null; }
  async setBullJobId(id: string, bullJobId: string) { this.touch(id, { bullJobId }); }
  async claim(id: string) {
    const row = this.rows.get(id);
    if (!row || !['QUEUED', 'RUNNING'].includes(row.status)) return null;
    this.touch(id, { status: 'RUNNING', attempts: row.attempts + 1, startedAt: new Date() });
    return this.findById(id);
  }
  async transition(id: string, from: string[], patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return null;
    this.touch(id, patch);
    return this.findById(id);
  }
  async writeProgress(id: string, progress: any) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'RUNNING') return false;
    this.touch(id, { progress });
    return true;
  }
  async patch(id: string, patch: Partial<BackgroundJobEntity>) { this.touch(id, patch); }
  private touch(id: string, patch: Partial<BackgroundJobEntity>) {
    const row = this.rows.get(id);
    if (row) Object.assign(row, patch, { updatedAt: new Date() });
  }
}

const REQUESTER: ReportRequester = {
  actor: { userId: 'user-1', roleNames: ['OPERATIONS'], organizationId: 'org-1' },
  regions: ['WEST'],
};

describe('ReportJobsService', () => {
  let service: ReportJobsService;
  let rows: FakeRowStore;
  let storage: { saveFile: jest.Mock; deleteFile: jest.Mock };
  let tracker: BackgroundJobTracker;

  const queue = { name: REPORT_QUEUE, add: jest.fn(), getJob: jest.fn(), getJobs: jest.fn() };
  const files = { get: jest.fn(), put: jest.fn(), secondsRemaining: jest.fn() };

  const doneJob = (overrides: Record<string, unknown> = {}) => ({
    id: 8,
    name: REPORT_JOB.ASSIGNMENTS,
    data: { requestedBy: 'user-1' },
    timestamp: 1,
    processedOn: 2,
    finishedOn: 3,
    returnvalue: { filename: 'assignments_8.xlsx', mimeType: 'application/xlsx', sizeBytes: 2048 },
    progress: () => 0,
    getState: async () => 'completed',
    ...overrides,
  });

  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  beforeEach(() => {
    jest.clearAllMocks();
    rows = new FakeRowStore();
    storage = { saveFile: jest.fn(async () => 'object-key'), deleteFile: jest.fn() };
    const jobs = new BackgroundJobsService(
      rows as any, new BackgroundJobRegistry(), { name: 'tracked-jobs' } as any, storage as any, { publish: jest.fn() } as any,
    );
    tracker = new BackgroundJobTracker(rows as any, jobs, storage as any);
    service = new ReportJobsService(queue as any, files as unknown as ReportFileStore, jobs);

    let seq = 7;
    queue.getJobs.mockResolvedValue([]);
    queue.add.mockImplementation(async (name: string, data: unknown, opts: unknown) => ({ id: ++seq, name, data, opts }));
    files.secondsRemaining.mockResolvedValue(880);
  });

  const onlyRow = () => {
    expect(rows.rows.size).toBe(1);
    return [...rows.rows.values()][0];
  };

  describe('enqueue', () => {
    it('adds a NAMED job matching the processor handler', async () => {
      // `scope` is required on the payload rather than optional, like the sibling exports'.
      // An optional field is one an enqueue site can forget, and the billing export is exactly
      // the one that forgot it — the worker then ran unscoped and produced the national book.
      await service.enqueueBilling({ clientId: 'c-1', scope: null }, REQUESTER);

      expect(queue.add.mock.calls[0][0]).toBe(REPORT_JOB.BILLING);
      expect(queue.add.mock.calls[0][0]).toBeTruthy();
    });

    it('bounds retention and does not retry', async () => {
      await service.enqueueCommandCenter({ scope: null }, REQUESTER);
      const opts = queue.add.mock.calls[0][2];

      expect(opts.removeOnComplete).toEqual(REPORT_COMPLETED_RETENTION);
      expect(opts.removeOnFail).toEqual(FAILED_JOB_RETENTION);
      expect(opts.attempts).toBe(1);
      expect(opts.timeout).toBeGreaterThan(0);
    });

    it('keeps the job record alive at least as long as the file it points at', async () => {
      // A poll that reports `done` for a job whose file has already been evicted is a link that
      // 404s. Bull's retention must not be the shorter of the two.
      expect(REPORT_COMPLETED_RETENTION.age).toBeGreaterThanOrEqual(REPORT_RESULT_TTL_SECONDS);
    });

    it('stores only the principal snapshot for the roster export, never a user record', async () => {
      // The roster sheet's PII columns are decided by roles, and only roles are needed to decide
      // them. Putting the whole user entity in a Redis payload would store that person's own
      // PAN, bank and contact details to answer a question about roles.
      await service.enqueueAssayerRoster(
        { principal: { id: 'user-1', roles: ['OPERATIONS'] }, scope: null },
        REQUESTER,
      );

      const payload = queue.add.mock.calls[0][1];
      expect(payload.principal).toEqual({ id: 'user-1', roles: ['OPERATIONS'] });
      expect(JSON.stringify(payload)).not.toMatch(/panNumber|bankAccountNumber|passwordHash/);
    });

    it('freezes the resolved scope into the payload', async () => {
      const scope = { regions: ['WEST'] as any };
      await service.enqueueAssignments({ status: 'PENDING', scope }, REQUESTER);
      expect(queue.add.mock.calls[0][1]).toMatchObject({ status: 'PENDING', scope, requestedBy: 'user-1' });
    });
  });

  describe('tracking (kind REPORT_EXPORT)', () => {
    it('writes a REPORT_EXPORT row named for the report, owned by the requester, within their regions', async () => {
      const enqueued = await service.enqueueBilling({ clientId: 'c-1', state: 'BILLED' as any, scope: null }, REQUESTER);

      const row = onlyRow();
      expect(row).toMatchObject({
        kind: 'REPORT_EXPORT',
        status: 'QUEUED',
        scopeType: 'BILLING',
        scopeId: null,
        title: 'Billing export',
        requestedBy: 'user-1',
        regions: ['WEST'],
        runnerQueue: REPORT_QUEUE,
        bullJobId: enqueued.jobId,
      });
      expect(row.params).toEqual({ clientId: 'c-1', state: 'BILLED' });
      // The Bull job points back at its row — what lets the worker settle it.
      expect(queue.add.mock.calls[0][1].backgroundJobId).toBe(row.id);
      expect(enqueued).toEqual({ jobId: '8', deduplicated: false, backgroundJobId: row.id });
    });

    it.each([
      ['enqueueAssignments', 'ASSIGNMENTS', { scope: null }],
      ['enqueueCommandCenter', 'COMMAND_CENTER', { scope: null }],
      ['enqueueAssayerRoster', 'ASSAYER_ROSTER', { principal: { id: 'user-1', roles: [] }, scope: null }],
      ['enqueueAssayerRosterPdf', 'ASSAYER_ROSTER_PDF', { principal: { id: 'user-1', roles: [] }, scope: null }],
    ])('%s is tracked under scopeType %s', async (method, scopeType, params) => {
      await (service as any)[method](params, REQUESTER);
      expect(onlyRow().scopeType).toBe(scopeType);
    });

    it('never displays the frozen scope or the principal snapshot as the row\'s params', async () => {
      await service.enqueueAssayerRoster(
        { principal: { id: 'user-1', roles: ['OPERATIONS'] }, scope: { regions: ['WEST'] as any } },
        REQUESTER,
      );
      expect(onlyRow().params).toEqual({});
    });
  });

  describe('in-flight deduplication', () => {
    it('joins an identical export already building rather than building it twice — and writes no second row', async () => {
      const first = await service.enqueueAssignments({ status: 'PENDING', scope: null }, REQUESTER);
      queue.getJobs.mockResolvedValue([
        { id: 8, name: REPORT_JOB.ASSIGNMENTS, data: queue.add.mock.calls[0][1] },
      ]);

      const second = await service.enqueueAssignments({ status: 'PENDING', scope: null }, REQUESTER);

      expect(second).toEqual({ jobId: first.jobId, deduplicated: true, backgroundJobId: first.backgroundJobId });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(rows.rows.size).toBe(1);
    });

    it('treats a changed filter as a new export', async () => {
      await service.enqueueAssignments({ status: 'PENDING', scope: null }, REQUESTER);
      queue.getJobs.mockResolvedValue([
        { id: 8, name: REPORT_JOB.ASSIGNMENTS, data: queue.add.mock.calls[0][1] },
      ]);

      const changed = await service.enqueueAssignments({ status: 'COMPLETED', scope: null }, REQUESTER);
      expect(changed.deduplicated).toBe(false);
      expect(rows.rows.size).toBe(2);
    });

    it('never joins a FINISHED export', async () => {
      await service.enqueueAssignments({ status: 'PENDING', scope: null }, REQUESTER);
      queue.getJobs.mockImplementation(async (states: string[]) =>
        states.includes('completed') ? [{ id: 8, name: REPORT_JOB.ASSIGNMENTS, data: queue.add.mock.calls[0][1] }] : [],
      );

      const again = await service.enqueueAssignments({ status: 'PENDING', scope: null }, REQUESTER);
      expect(again.deduplicated).toBe(false);
    });
  });

  describe('the worker settles the row with a download link', () => {
    const reports = { billing: jest.fn(), assayerRosterPdf: jest.fn() };

    async function runQueued(handler: 'billing' | 'assayerRosterPdf') {
      const [name, data, opts] = queue.add.mock.calls[0];
      const bullJob = { id: 8, name, data, opts, attemptsMade: 0, progress: jest.fn() };
      const worker = new ReportJobsWorker(reports as any, files as unknown as ReportFileStore, tracker);
      return worker[handler](bullJob as any);
    }

    it('goes RUNNING with progress, then SUCCEEDED with the existing download route, expiring with the file', async () => {
      await service.enqueueBilling({ clientId: 'c-1', scope: null }, REQUESTER);
      const bytes = Buffer.alloc(Math.round(1.2 * 1024 * 1024), 1);
      let seenWhileRunning: unknown;
      reports.billing.mockImplementation(async (_filters: unknown, onProgress: any) => {
        await onProgress(1, 3, 'Writing workbook');
        seenWhileRunning = { ...onlyRow() };
        return bytes;
      });
      const before = Date.now();

      const result = await runQueued('billing');

      expect(seenWhileRunning).toMatchObject({ status: 'RUNNING', progress: { processed: 1, total: 3, stage: 'Writing workbook' } });
      const row = onlyRow();
      expect(row.status).toBe('SUCCEEDED');
      expect(row.result).toMatchObject({
        summary: 'Billing export ready (1.2 MB)',
        download: { path: '/reports/jobs/8/download', fileName: 'billing_8.xlsx' },
      });
      const expiresAt = Date.parse(row.result!.download!.expiresAt!);
      expect(expiresAt).toBeGreaterThanOrEqual(before + REPORT_RESULT_TTL_SECONDS * 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + REPORT_RESULT_TTL_SECONDS * 1000);
      // Bull's return value — what `GET /reports/jobs/:id` reads — is unchanged.
      expect(result).toEqual({ filename: 'billing_8.xlsx', mimeType: expect.any(String), sizeBytes: bytes.length });
    });

    it('does NOT copy the bytes onto the row: exports hold PAN/bank columns and live 15 minutes only', async () => {
      await service.enqueueAssayerRosterPdf({ principal: { id: 'user-1', roles: [] }, scope: null }, REQUESTER);
      reports.assayerRosterPdf.mockResolvedValue(Buffer.from('%PDF'));

      await runQueued('assayerRosterPdf');

      expect(storage.saveFile).not.toHaveBeenCalled();
      const row = onlyRow();
      expect(row.resultObjectKey).toBeNull();
      expect(files.put).toHaveBeenCalledWith('8', expect.any(Buffer));
      expect(row.result?.summary).toBe('Assayer roster (PDF) ready (1 KB)');
    });

    it('records a failed export on the row with the operator-facing message, and still fails the Bull job', async () => {
      await service.enqueueBilling({ clientId: 'c-9', scope: null }, REQUESTER);
      reports.billing.mockRejectedValue(new Error('Client c-9 not found.'));

      await expect(runQueued('billing')).rejects.toThrow('Client c-9 not found.');
      expect(onlyRow()).toMatchObject({ status: 'FAILED', error: 'Client c-9 not found.' });
      expect(files.put).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('reports the file metadata and how long is left to fetch it', async () => {
      queue.getJob.mockResolvedValue(doneJob());

      const status = await service.status('8', 'user-1');

      expect(status.state).toBe('done');
      expect(status.result).toMatchObject({ filename: 'assignments_8.xlsx', sizeBytes: 2048 });
      expect(status.expiresInSeconds).toBe(880);
    });

    it('never carries the workbook bytes', async () => {
      // A client polling every two seconds would otherwise pull the whole file out of Redis on
      // every tick to render a progress bar.
      queue.getJob.mockResolvedValue(doneJob());

      const status = await service.status('8', 'user-1');

      expect(JSON.stringify(status)).not.toMatch(/contentBase64|buffer/i);
      expect(files.get).not.toHaveBeenCalled();
    });

    it('does not ask Redis for a TTL while the job is still running', async () => {
      queue.getJob.mockResolvedValue(doneJob({ getState: async () => 'active', finishedOn: null }));

      const status = await service.status('8', 'user-1');

      expect(status.state).toBe('running');
      expect(status.expiresInSeconds).toBeNull();
      expect(files.secondsRemaining).not.toHaveBeenCalled();
    });

    it('refuses a job belonging to another account', async () => {
      queue.getJob.mockResolvedValue(doneJob({ data: { requestedBy: 'someone-else' } }));
      await expect(service.status('8', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('download', () => {
    it('returns the workbook and its metadata to the account that requested it', async () => {
      queue.getJob.mockResolvedValue(doneJob());
      files.get.mockResolvedValue(Buffer.from('PK'));

      const { buffer, meta } = await service.download('8', 'user-1');

      expect(buffer.toString()).toBe('PK');
      expect(meta.filename).toBe('assignments_8.xlsx');
    });

    it('checks the job owner BEFORE reading the file', async () => {
      // Otherwise the file key would be an unauthenticated side door around the rule that
      // governs polling.
      queue.getJob.mockResolvedValue(doneJob({ data: { requestedBy: 'someone-else' } }));

      await expect(service.download('8', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(files.get).not.toHaveBeenCalled();
    });

    it('explains that an expired export needs re-running', async () => {
      queue.getJob.mockResolvedValue(doneJob());
      files.get.mockResolvedValue(null);

      await expect(service.download('8', 'user-1')).rejects.toThrow(/expired/i);
    });

    it('tells a caller who downloaded too early to keep polling', async () => {
      queue.getJob.mockResolvedValue(doneJob({ getState: async () => 'active' }));
      await expect(service.download('8', 'user-1')).rejects.toThrow(/has not finished yet/i);
    });

    it('surfaces the failure reason rather than a bare "no file"', async () => {
      queue.getJob.mockResolvedValue(
        doneJob({ getState: async () => 'failed', failedReason: 'This export came to 41.2 MB, over the 20 MB limit' }),
      );

      await expect(service.download('8', 'user-1')).rejects.toThrow(/over the 20 MB limit/);
    });
  });

  describe('size ceiling', () => {
    it('is a real bound, not a placeholder', () => {
      // The bytes live in the same Redis that backs the socket adapter, the RBAC cache and the
      // throttler. An export that succeeds and evicts the cache is worse than one that refuses.
      expect(MAX_EXPORT_BYTES).toBeGreaterThan(0);
      expect(MAX_EXPORT_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
    });
  });
});
