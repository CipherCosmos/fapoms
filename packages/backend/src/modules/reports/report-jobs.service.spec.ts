import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException } from '@nestjs/common';

import { ReportJobsService } from './report-jobs.service';
import { ReportFileStore } from './report-file.store';
import {
  REPORT_JOB,
  REPORT_QUEUE,
  REPORT_COMPLETED_RETENTION,
  REPORT_RESULT_TTL_SECONDS,
  MAX_EXPORT_BYTES,
} from './report-jobs.contract';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';

describe('ReportJobsService', () => {
  let service: ReportJobsService;

  const queue = { add: jest.fn(), getJob: jest.fn(), getJobs: jest.fn() };
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportJobsService,
        { provide: getQueueToken(REPORT_QUEUE), useValue: queue },
        { provide: ReportFileStore, useValue: files },
      ],
    }).compile();

    service = module.get(ReportJobsService);
    jest.clearAllMocks();
    queue.getJobs.mockResolvedValue([]);
    queue.add.mockImplementation(async (name: string) => ({ id: 8, name }));
    files.secondsRemaining.mockResolvedValue(880);
  });

  describe('enqueue', () => {
    it('adds a NAMED job matching the processor handler', async () => {
      await service.enqueueBilling({ clientId: 'c-1' }, 'user-1');

      expect(queue.add.mock.calls[0][0]).toBe(REPORT_JOB.BILLING);
      expect(queue.add.mock.calls[0][0]).toBeTruthy();
    });

    it('bounds retention and does not retry', async () => {
      await service.enqueueCommandCenter({ scope: null }, 'user-1');
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
        { principal: { id: 'user-1', roles: ['HR_MANAGER'] }, scope: null },
        'user-1',
      );

      const payload = queue.add.mock.calls[0][1];
      expect(payload.principal).toEqual({ id: 'user-1', roles: ['HR_MANAGER'] });
      expect(JSON.stringify(payload)).not.toMatch(/panNumber|bankAccountNumber|passwordHash/);
    });

    it('freezes the resolved scope into the payload', async () => {
      const scope = { regions: ['WEST'] as any };
      await service.enqueueAssignments({ status: 'PENDING', scope }, 'user-1');
      expect(queue.add.mock.calls[0][1]).toMatchObject({ status: 'PENDING', scope });
    });
  });

  describe('in-flight deduplication', () => {
    it('joins an identical export already building rather than building it twice', async () => {
      const first = await service.enqueueAssignments({ status: 'PENDING', scope: null }, 'user-1');
      queue.getJobs.mockResolvedValue([
        { id: 8, name: REPORT_JOB.ASSIGNMENTS, data: queue.add.mock.calls[0][1] },
      ]);

      const second = await service.enqueueAssignments({ status: 'PENDING', scope: null }, 'user-1');

      expect(second).toEqual({ jobId: first.jobId, deduplicated: true });
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('treats a changed filter as a new export', async () => {
      await service.enqueueAssignments({ status: 'PENDING', scope: null }, 'user-1');
      queue.getJobs.mockResolvedValue([
        { id: 8, name: REPORT_JOB.ASSIGNMENTS, data: queue.add.mock.calls[0][1] },
      ]);

      const changed = await service.enqueueAssignments({ status: 'COMPLETED', scope: null }, 'user-1');
      expect(changed.deduplicated).toBe(false);
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
