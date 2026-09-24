import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { ReportJobsWorker } from './report-jobs.worker';
import { ReportsService } from './reports.service';
import { ReportFileStore, ReportTooLargeError } from './report-file.store';
import { REPORT_JOB, REPORT_QUEUE, MAX_EXPORT_BYTES } from './report-jobs.contract';
import { EXCEL_MIME } from './excel-export';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';
import { progressReporter } from '../../infrastructure/queue/queued-job';

/** @nestjs/bull's own metadata keys — see node_modules/@nestjs/bull/dist/bull.constants.js. */
const BULL_MODULE_QUEUE = 'bull:module_queue';
const BULL_MODULE_QUEUE_PROCESS = 'bull:module_queue_process';

function jobStub(name: string, data: Record<string, unknown>) {
  return { id: 11, name, data, progress: jest.fn().mockResolvedValue(undefined) } as any;
}

describe('ReportJobsWorker', () => {
  let worker: ReportJobsWorker;

  const reportsService = {
    assignments: jest.fn(),
    billing: jest.fn(),
    commandCenter: jest.fn(),
    assayerRoster: jest.fn(),
    assayerRosterPdf: jest.fn(),
  };
  const files = { put: jest.fn(), get: jest.fn(), secondsRemaining: jest.fn() };
  /** An untracked run, as the real tracker does for a job with no row: Bull progress only. */
  const tracker = {
    run: jest.fn((job: any, work: any, _options: any) =>
      work({ backgroundJobId: null, progress: progressReporter(job), stage: jest.fn(), attachReport: jest.fn() })),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportJobsWorker,
        { provide: ReportsService, useValue: reportsService },
        { provide: ReportFileStore, useValue: files },
        { provide: BackgroundJobTracker, useValue: tracker },
      ],
    }).compile();

    worker = module.get(ReportJobsWorker);
    jest.clearAllMocks();
    for (const fn of Object.values(reportsService)) fn.mockResolvedValue(Buffer.alloc(4096, 1));
    files.put.mockResolvedValue(undefined);
  });

  /** Same regression as the planning worker: a bare @Process() would silently handle nothing. */
  describe('handler registration', () => {
    it('is attached to the report queue', () => {
      expect(Reflect.getMetadata(BULL_MODULE_QUEUE, ReportJobsWorker)).toMatchObject({ name: REPORT_QUEUE });
    });

    it('has exactly ONE loop for the whole queue, at concurrency 1', () => {
      // Five named handlers used to be five SHARED loops (Bull's loops belong to the queue and take
      // any job name): up to five synchronous \`xlsx.write\` builds at once, each freezing the process.
      const handlers = Object.getOwnPropertyNames(ReportJobsWorker.prototype)
        .map((m) => Reflect.getMetadata(BULL_MODULE_QUEUE_PROCESS, (ReportJobsWorker.prototype as any)[m]))
        .filter(Boolean);
      expect(handlers).toEqual([expect.objectContaining({ name: '*', concurrency: 1 })]);
    });

    it.each([
      ['assignments', REPORT_JOB.ASSIGNMENTS],
      ['billing', REPORT_JOB.BILLING],
      ['commandCenter', REPORT_JOB.COMMAND_CENTER],
      ['assayerRoster', REPORT_JOB.ASSAYER_ROSTER],
      ['assayerRosterPdf', REPORT_JOB.ASSAYER_ROSTER_PDF],
    ])('dispatches %s from the one loop by the exact name the enqueue side uses', async (method, name) => {
      const spy = jest.spyOn(worker as any, method).mockResolvedValue({ filename: 'x', mimeType: 'y', sizeBytes: 1 });
      await worker.run({ id: 1, name, data: {} } as any);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('refuses a job name it does not know rather than completing it silently', async () => {
      await expect(worker.run({ id: 1, name: 'nope', data: {} } as any)).rejects.toThrow('Unknown report job');
    });
  });

  describe('producing a workbook', () => {
    it('calls the same service method the synchronous route calls, with the same filters', async () => {
      await worker.assignments(
        jobStub(REPORT_JOB.ASSIGNMENTS, {
          status: 'PENDING',
          projectBranchStatus: 'IMPORTED',
          priority: 'HIGH',
          scope: { regions: ['WEST'] },
        }),
      );

      expect(reportsService.assignments).toHaveBeenCalledWith(
        { status: 'PENDING', projectBranchStatus: 'IMPORTED', priority: 'HIGH', scope: { regions: ['WEST'] } },
        expect.any(Function),
      );
    });

    it('stores the bytes against the job id and returns metadata only', async () => {
      const result = await worker.assignments(jobStub(REPORT_JOB.ASSIGNMENTS, { scope: null }));

      expect(files.put).toHaveBeenCalledWith('11', expect.any(Buffer));
      expect(result).toEqual({ filename: 'assignments_11.xlsx', mimeType: EXCEL_MIME, sizeBytes: 4096 });
      // The bytes must not ride in the job result — a poll would carry them on every tick.
      expect(Object.keys(result)).not.toContain('buffer');
    });

    it('names the file after the job id, so three open exports are distinguishable', async () => {
      const result = await worker.billing(jobStub(REPORT_JOB.BILLING, { clientId: 'c-1' }));
      expect(result.filename).toBe('billing_11.xlsx');
    });

    it('passes the principal snapshot, not a user record, to the roster export', async () => {
      const principal = { id: 'user-1', roles: ['OPERATIONS'] };
      await worker.assayerRoster(jobStub(REPORT_JOB.ASSAYER_ROSTER, { principal, scope: null }));

      expect(reportsService.assayerRoster).toHaveBeenCalledWith(principal, { scope: undefined }, expect.any(Function));
    });

    it('turns a null scope into undefined rather than an empty scope object', async () => {
      await worker.commandCenter(jobStub(REPORT_JOB.COMMAND_CENTER, { scope: null }));
      expect(reportsService.commandCenter).toHaveBeenCalledWith({}, expect.any(Function));
    });

    it('runs every export through the tracker, whose summary links to the download route', async () => {
      await worker.assayerRosterPdf(jobStub(REPORT_JOB.ASSAYER_ROSTER_PDF, { principal: { id: 'u', roles: [] }, scope: null }));

      expect(tracker.run).toHaveBeenCalledTimes(1);
      const { describe } = tracker.run.mock.calls[0][2];
      const summary = describe({ filename: 'assayer_roster_11.pdf', mimeType: 'application/pdf', sizeBytes: 2048 });
      expect(summary).toMatchObject({
        summary: 'Assayer roster (PDF) ready (2 KB)',
        download: { path: '/reports/jobs/11/download', fileName: 'assayer_roster_11.pdf', expiresAt: expect.any(String) },
      });
    });

    it('relays phase progress from the service onto the job', async () => {
      const job = jobStub(REPORT_JOB.COMMAND_CENTER, { scope: null });
      reportsService.commandCenter.mockImplementation(async (_scope, onProgress) => {
        await onProgress(0, 3, 'Computing territory overview');
        await onProgress(2, 3, 'Writing workbook');
        return Buffer.alloc(10);
      });

      await worker.commandCenter(job);

      expect(job.progress).toHaveBeenCalledWith({ percent: 0, stage: 'Computing territory overview (0/3)' });
      expect(job.progress).toHaveBeenCalledWith({ percent: 67, stage: 'Writing workbook (2/3)' });
    });
  });

  describe('failure handling', () => {
    it('lets an oversized export fail the job with wording aimed at the operator', async () => {
      // Better than an export that "succeeds" and hands back a download that 404s, and better
      // than one that succeeds and evicts the RBAC cache from the shared Redis.
      files.put.mockRejectedValue(new ReportTooLargeError(MAX_EXPORT_BYTES * 2));

      await expect(worker.assignments(jobStub(REPORT_JOB.ASSIGNMENTS, { scope: null }))).rejects.toThrow(
        /Narrow the filter/,
      );
    });

    it('does not store anything when the build itself fails', async () => {
      reportsService.billing.mockRejectedValue(new Error('Client c-9 not found.'));

      await expect(worker.billing(jobStub(REPORT_JOB.BILLING, { clientId: 'c-9' }))).rejects.toThrow(
        'Client c-9 not found.',
      );
      expect(files.put).not.toHaveBeenCalled();
    });
  });
});
