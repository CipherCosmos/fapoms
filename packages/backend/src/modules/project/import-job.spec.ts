/**
 * Guards the queued-import path.
 *
 * What is worth testing here is not "does Bull work" — it does — but the four decisions layered
 * on top of it, each of which was a real failure or a real risk:
 *
 *  1. **Which files get queued.** Get the threshold wrong in one direction and a 2,000-row import
 *     runs in an HTTP request that times out at 300 seconds; get it wrong in the other and every
 *     routine 6-branch correction becomes an asynchronous job an operator has to poll.
 *  2. **The job name matches the handler name.** The shared `background-jobs` queue in this
 *     codebase gets exactly this wrong, and the symptom is silence: named jobs added to an
 *     unnamed processor are never picked up and eventually dead-lettered.
 *  3. **Retention is bounded.** These jobs each carry a whole workbook; `removeOnComplete: false`
 *     — the pattern used elsewhere here — would accumulate them in Redis indefinitely.
 *  4. **A job id cannot be walked across projects.** Bull ids are a per-queue counter.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';

import { ImportJobService } from './import-job.service';
import { ImportJobWorker } from './import-job.worker';
import { IMPORT_QUEUE, BRANCH_IMPORT_JOB } from './import-job.constants';
import { ProjectService } from './project.service';

describe('ImportJobService', () => {
  let service: ImportJobService;

  const mockQueue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportJobService,
        { provide: getQueueToken(IMPORT_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(ImportJobService);
    jest.clearAllMocks();
    delete process.env.BRANCH_IMPORT_SYNC_GEOCODE_LIMIT;
    delete process.env.BRANCH_IMPORT_SYNC_ROW_LIMIT;
  });

  describe('shouldQueue', () => {
    it('runs the everyday small correction sheet synchronously', () => {
      // The largest client on the platform has 72 branches, and a re-uploaded correction sheet
      // usually carries its coordinates already. This case must not become asynchronous.
      expect(ImportJobService.shouldQueue({ totalRows: 72, rowsNeedingGeocode: 0 })).toBe(false);
    });

    /**
     * The decision is driven by geocodes, not row count, because that is what actually costs
     * time: the free OSM tiers are limited to roughly one lookup per second.
     */
    it('queues a small file that nonetheless needs many address lookups', () => {
      expect(ImportJobService.shouldQueue({ totalRows: 60, rowsNeedingGeocode: 60 })).toBe(true);
    });

    it('does not queue a large file whose rows all carry their own coordinates', () => {
      expect(ImportJobService.shouldQueue({ totalRows: 150, rowsNeedingGeocode: 0 })).toBe(false);
    });

    /**
     * …but only up to a point. Even fully-located rows write a branch, a project_branch and an
     * assessment each, and that adds up on its own.
     */
    it('queues a very large file even with every coordinate supplied', () => {
      expect(ImportJobService.shouldQueue({ totalRows: 2000, rowsNeedingGeocode: 0 })).toBe(true);
    });

    it('lets a deployment move the thresholds', () => {
      process.env.BRANCH_IMPORT_SYNC_GEOCODE_LIMIT = '5';
      expect(ImportJobService.shouldQueue({ totalRows: 10, rowsNeedingGeocode: 6 })).toBe(true);
      expect(ImportJobService.shouldQueue({ totalRows: 10, rowsNeedingGeocode: 5 })).toBe(false);
    });
  });

  describe('job options', () => {
    /**
     * `removeOnComplete: false` is what the rest of this codebase uses, and it means "keep every
     * job forever". These payloads are whole workbooks, so that is a slow Redis leak — and Redis
     * here also backs the queue, the socket adapter and the rate-limit store, so filling it takes
     * more than imports down with it.
     */
    it('bounds retention by both age and count, for successes and failures', () => {
      const { removeOnComplete, removeOnFail } = ImportJobService.JOB_OPTIONS;

      expect(removeOnComplete).toEqual({ age: expect.any(Number), count: expect.any(Number) });
      expect(removeOnFail).toEqual({ age: expect.any(Number), count: expect.any(Number) });
      expect(removeOnComplete).not.toBe(false);
      expect(removeOnFail).not.toBe(false);
    });

    /**
     * A retry would silently re-geocode the whole file — the twenty-minute part — to re-apply
     * writes that already landed, and tell nobody it was doing so.
     */
    it('does not retry an import automatically', () => {
      expect(ImportJobService.JOB_OPTIONS.attempts).toBe(1);
    });
  });

  describe('enqueueBranchImport', () => {
    beforeEach(() => {
      mockQueue.add.mockResolvedValue({ id: 42 });
    });

    /**
     * The name is the entire routing mechanism: Bull delivers a named job only to a handler
     * registered under that exact name, and a mismatch fails silently rather than loudly.
     */
    it('adds the job under the name the worker handles', async () => {
      await service.enqueueBranchImport({
        projectId: 'p-1', userId: 'u-1', fileBuffer: Buffer.from('xlsx'),
        fileName: 'branches.xlsx', totalRows: 400, rowsNeedingGeocode: 400,
      });

      expect(mockQueue.add).toHaveBeenCalledWith(
        BRANCH_IMPORT_JOB,
        expect.objectContaining({ projectId: 'p-1', userId: 'u-1' }),
        ImportJobService.JOB_OPTIONS,
      );
    });

    it('carries the workbook in the payload so any worker replica can run it', async () => {
      const fileBuffer = Buffer.from('a real workbook would go here');

      await service.enqueueBranchImport({
        projectId: 'p-1', userId: 'u-1', fileBuffer,
        fileName: null, totalRows: 400, rowsNeedingGeocode: 400,
      });

      const [, data] = mockQueue.add.mock.calls[0];
      expect(Buffer.from(data.fileBase64, 'base64').equals(fileBuffer)).toBe(true);
    });

    it('reports the job as waiting, with the work it represents', async () => {
      const status = await service.enqueueBranchImport({
        projectId: 'p-1', userId: 'u-1', fileBuffer: Buffer.from('x'),
        fileName: 'roster.xlsx', totalRows: 400, rowsNeedingGeocode: 380,
      });

      expect(status).toMatchObject({
        jobId: '42', state: 'waiting', progress: null, result: null, error: null,
        totalRows: 400, rowsNeedingGeocode: 380, fileName: 'roster.xlsx',
      });
    });

    /**
     * Base64 inflates by a third and Redis holds the payload for the whole retention window.
     * Nothing legitimate approaches this, so it only ever fires on a mistake — and a clear
     * refusal beats filling the Redis that the queue, the realtime adapter and the throttler
     * all share.
     */
    it('refuses a file too large to park in Redis', async () => {
      const huge = Buffer.alloc(ImportJobService.MAX_QUEUED_FILE_BYTES + 1);

      await expect(service.enqueueBranchImport({
        projectId: 'p-1', userId: 'u-1', fileBuffer: huge,
        fileName: null, totalRows: 1, rowsNeedingGeocode: 0,
      })).rejects.toThrow(PayloadTooLargeException);

      expect(mockQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('getBranchImportStatus', () => {
    const job = (over: Record<string, any> = {}) => ({
      id: 7,
      data: { projectId: 'p-1', fileName: 'b.xlsx', totalRows: 400, rowsNeedingGeocode: 400 },
      getState: jest.fn().mockResolvedValue('active'),
      progress: jest.fn().mockReturnValue(0),
      returnvalue: null,
      failedReason: null,
      timestamp: 1_700_000_000_000,
      processedOn: null,
      finishedOn: null,
      ...over,
    });

    it('reports progress once the worker has published some', async () => {
      const reported = { processed: 120, total: 400, created: 118, updated: 0, linked: 118, skipped: 2, imprecise: 9 };
      mockQueue.getJob.mockResolvedValue(job({ progress: jest.fn().mockReturnValue(reported) }));

      const status = await service.getBranchImportStatus('p-1', '7');

      expect(status.state).toBe('active');
      expect(status.progress).toEqual(reported);
    });

    /**
     * Bull returns 0 from `progress()` for a job that has never reported. Handed through as-is
     * that renders as a progress object of zeroes, which is indistinguishable from an import
     * that has started and found nothing.
     */
    it('does not mistake "never reported" for a progress reading', async () => {
      mockQueue.getJob.mockResolvedValue(job());

      expect((await service.getBranchImportStatus('p-1', '7')).progress).toBeNull();
    });

    it('returns the result only once the job has completed', async () => {
      const outcome = { totalRows: 400, created: 390, updated: 0, linked: 390, skipped: [], imprecise: [] };
      mockQueue.getJob.mockResolvedValue(job({
        getState: jest.fn().mockResolvedValue('completed'),
        returnvalue: outcome,
        finishedOn: 1_700_000_600_000,
      }));

      const status = await service.getBranchImportStatus('p-1', '7');

      expect(status.result).toEqual(outcome);
      expect(status.error).toBeNull();
      expect(status.finishedAt).toBe(new Date(1_700_000_600_000).toISOString());
    });

    it('surfaces why a failed import failed', async () => {
      mockQueue.getJob.mockResolvedValue(job({
        getState: jest.fn().mockResolvedValue('failed'),
        failedReason: 'connect ETIMEDOUT',
      }));

      const status = await service.getBranchImportStatus('p-1', '7');

      expect(status.error).toBe('connect ETIMEDOUT');
      expect(status.result).toBeNull();
    });

    /**
     * The one with security consequences. Bull job ids are a per-queue incrementing integer, so
     * without this check anyone who may read one project could walk `1, 2, 3…` and pull back
     * other projects' import results — which name real branches, addresses and failure reasons.
     * Reported as "not found" rather than "forbidden" so the response cannot be used to confirm
     * that another project's job id exists.
     */
    it('refuses a job id belonging to a different project', async () => {
      mockQueue.getJob.mockResolvedValue(job({ data: { projectId: 'p-OTHER', totalRows: 1, rowsNeedingGeocode: 0, fileName: null } }));

      await expect(service.getBranchImportStatus('p-1', '7')).rejects.toThrow(NotFoundException);
    });

    it('explains that an old job was cleared rather than lost', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      await expect(service.getBranchImportStatus('p-1', '999')).rejects.toThrow(/kept for 24 hours/);
    });
  });
});

describe('ImportJobWorker', () => {
  let worker: ImportJobWorker;

  const mockProjectService = { runBranchImport: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportJobWorker,
        { provide: ProjectService, useValue: mockProjectService },
      ],
    }).compile();

    worker = module.get(ImportJobWorker);
    jest.clearAllMocks();
  });

  const outcome = { totalRows: 3, created: 3, updated: 0, linked: 3, skipped: [], imprecise: [] };

  const jobFor = (over: Record<string, any> = {}) => ({
    id: 11,
    data: {
      projectId: 'p-1', userId: 'u-1',
      fileBase64: Buffer.from('workbook bytes').toString('base64'),
      fileName: 'b.xlsx', totalRows: 3, rowsNeedingGeocode: 3,
    },
    progress: jest.fn().mockResolvedValue(undefined),
    ...over,
  }) as any;

  it('decodes the workbook and runs the import for the enqueuing user', async () => {
    mockProjectService.runBranchImport.mockResolvedValue(outcome);

    await worker.runBranchImport(jobFor());

    const [projectId, buffer, userId] = mockProjectService.runBranchImport.mock.calls[0];
    expect(projectId).toBe('p-1');
    expect(userId).toBe('u-1');
    expect(buffer.toString()).toBe('workbook bytes');
  });

  it('publishes progress onto the job as rows are worked', async () => {
    const reading = { processed: 10, total: 3, created: 10, updated: 0, linked: 10, skipped: 0, imprecise: 0 };
    mockProjectService.runBranchImport.mockImplementation(async (_p, _b, _u, onProgress: any) => {
      onProgress(reading);
      return outcome;
    });
    const job = jobFor();

    await worker.runBranchImport(job);

    expect(job.progress).toHaveBeenCalledWith(reading);
  });

  /**
   * A Redis hiccup while reporting progress must not abort an import that is otherwise
   * succeeding — the operator would rather have the branches and a stale progress bar than
   * neither. The rejection is swallowed deliberately; this proves it stays swallowed.
   */
  it('completes the import even if progress cannot be published', async () => {
    mockProjectService.runBranchImport.mockImplementation(async (_p, _b, _u, onProgress: any) => {
      onProgress({ processed: 1, total: 3, created: 1, updated: 0, linked: 1, skipped: 0, imprecise: 0 });
      return outcome;
    });
    const job = jobFor({ progress: jest.fn().mockRejectedValue(new Error('redis is down')) });

    await expect(worker.runBranchImport(job)).resolves.toEqual(outcome);
  });

  /**
   * A file with 12 unusable rows out of 400 is a successful import with a report attached, not a
   * failed job. Throwing would bury the 388 that landed behind a red "failed" state, and the
   * per-row reasons — the only thing that lets an operator fix their sheet — would end up in a
   * stack trace instead of the result.
   */
  it('returns a partial import as a result rather than failing the job', async () => {
    const partial = {
      totalRows: 400, created: 388, updated: 0, linked: 388,
      skipped: [{ row: 5, branchCode: 'BR-5', reason: 'No state for "Nowhere".' }],
      imprecise: [],
    };
    mockProjectService.runBranchImport.mockResolvedValue(partial);

    await expect(worker.runBranchImport(jobFor())).resolves.toEqual(partial);
  });
});
