import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { NotFoundException } from '@nestjs/common';

import { PlanningJobsService } from './planning-jobs.service';
import { PLANNING_JOB, PLANNING_QUEUE, PLANNING_COMPLETED_RETENTION } from './planning-jobs.contract';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';

describe('PlanningJobsService', () => {
  let service: PlanningJobsService;

  const queue = {
    add: jest.fn(),
    getJob: jest.fn(),
    getJobs: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlanningJobsService, { provide: getQueueToken(PLANNING_QUEUE), useValue: queue }],
    }).compile();

    service = module.get(PlanningJobsService);
    jest.clearAllMocks();
    queue.getJobs.mockResolvedValue([]);
    queue.add.mockImplementation(async (name: string) => ({ id: 42, name }));
  });

  describe('enqueue', () => {
    it('adds a NAMED job whose name matches the processor handler', async () => {
      // The defect this guards against is live on the shared 'background-jobs' queue:
      // BullQueueManager adds named jobs while BullProcessor declares a bare @Process(), which
      // in Bull only ever matches jobs added with NO name — so everything it enqueues stalls.
      // The name asserted here is the same constant PlanningJobsWorker decorates its handler
      // with, so the two halves cannot drift apart without this failing.
      await service.enqueueCoveragePlan('p-1', { regions: null }, 'user-1');

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add.mock.calls[0][0]).toBe(PLANNING_JOB.COVERAGE_PLAN);
      expect(PLANNING_JOB.COVERAGE_PLAN).toBe('coverage-plan');
    });

    it('returns the job id to poll', async () => {
      const result = await service.enqueueCoveragePlan('p-1', null, 'user-1');
      expect(result).toEqual({ jobId: '42', deduplicated: false });
    });

    it('freezes the resolved scope into the payload', async () => {
      // The worker has no request and therefore no principal. Without the scope travelling with
      // the job, a regional operator's queued run would execute unscoped and return the national
      // plan — branch list and candidate assayers included.
      const scope = { regions: ['WEST'] as any, state: 'MH' };
      await service.enqueueCoveragePlan('p-1', scope, 'user-1');

      expect(queue.add.mock.calls[0][1]).toMatchObject({ projectId: 'p-1', scope, requestedBy: 'user-1' });
    });

    it('bounds retention on both success and failure', async () => {
      // `removeOnComplete: false` — "keep every job forever" — is what filled Redis before.
      await service.enqueueCoveragePlan('p-1', null, 'user-1');
      const opts = queue.add.mock.calls[0][2];

      expect(opts.removeOnComplete).toEqual(PLANNING_COMPLETED_RETENTION);
      expect(opts.removeOnFail).toEqual(FAILED_JOB_RETENTION);
      expect(opts.removeOnComplete).not.toBe(false);
      expect(opts.removeOnFail).not.toBe(false);
      expect(PLANNING_COMPLETED_RETENTION.age).toBeGreaterThan(0);
      expect(PLANNING_COMPLETED_RETENTION.count).toBeGreaterThan(0);
    });

    it('does not retry, and releases the slot if a run wedges', async () => {
      // These jobs are read-only, so a retry would be safe — but their failures are
      // deterministic, so a second attempt spends the same seconds of CPU on a concurrency-1
      // queue to reach the same error.
      await service.enqueueCoveragePlan('p-1', null, 'user-1');
      const opts = queue.add.mock.calls[0][2];

      expect(opts.attempts).toBe(1);
      expect(opts.timeout).toBeGreaterThan(0);
    });

    it('sorts and de-duplicates day-plan project ids so ordering is not a second request', async () => {
      await service.enqueueDayPlans(['b', 'a', 'b'], undefined, undefined, 'user-1');
      expect(queue.add.mock.calls[0][1]).toMatchObject({ projectIds: ['a', 'b'] });
    });
  });

  describe('in-flight deduplication', () => {
    it('joins a queued run rather than starting an identical second one', async () => {
      // A POST that returns 202 invites retries: a page that re-fires on focus, or a
      // double-clicked button, can otherwise put ten identical 12-second runs on the queue.
      const first = await service.enqueueCoveragePlan('p-1', { regions: null }, 'user-1');
      const enqueuedData = queue.add.mock.calls[0][1];
      queue.getJobs.mockResolvedValue([{ id: 42, name: PLANNING_JOB.COVERAGE_PLAN, data: enqueuedData }]);

      const second = await service.enqueueCoveragePlan('p-1', { regions: null }, 'user-1');

      expect(second).toEqual({ jobId: first.jobId, deduplicated: true });
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('does not share a run between two accounts', async () => {
      await service.enqueueCoveragePlan('p-1', { regions: null }, 'user-1');
      queue.getJobs.mockResolvedValue([
        { id: 42, name: PLANNING_JOB.COVERAGE_PLAN, data: queue.add.mock.calls[0][1] },
      ]);

      const other = await service.enqueueCoveragePlan('p-1', { regions: null }, 'user-2');

      expect(other.deduplicated).toBe(false);
      expect(queue.add).toHaveBeenCalledTimes(2);
    });

    it('only ever scans unfinished states', async () => {
      // Matching a COMPLETED job would be worse than no deduplication: for the whole retention
      // window every re-request would return the first run's answer, so an operator who
      // reassigned a branch and pressed refresh would be told nothing had changed.
      await service.enqueueCoveragePlan('p-1', null, 'user-1');

      const states = queue.getJobs.mock.calls[0][0];
      expect(states).toEqual(['waiting', 'active', 'delayed']);
      expect(states).not.toContain('completed');
    });

    it('does not match a job of a different type that happens to share a fingerprint', async () => {
      await service.enqueueCoveragePlan('p-1', null, 'user-1');
      queue.getJobs.mockResolvedValue([
        { id: 9, name: PLANNING_JOB.PROJECT_CANDIDATES, data: queue.add.mock.calls[0][1] },
      ]);

      const again = await service.enqueueCoveragePlan('p-1', null, 'user-1');
      expect(again.deduplicated).toBe(false);
    });

    it('still accepts the work when the scan itself fails', async () => {
      // The scan is an optimisation. Failing the request because a Redis list read errored would
      // turn a hiccup into an outage of the endpoint; one redundant run is the cheaper mistake.
      queue.getJobs.mockRejectedValue(new Error('Redis is down'));

      await expect(service.enqueueCoveragePlan('p-1', null, 'user-1')).resolves.toEqual({
        jobId: '42',
        deduplicated: false,
      });
    });
  });

  describe('status', () => {
    it('returns the plan itself once the job is done', async () => {
      queue.getJob.mockResolvedValue({
        id: 42,
        name: PLANNING_JOB.COVERAGE_PLAN,
        data: { requestedBy: 'user-1' },
        timestamp: 1,
        processedOn: 2,
        finishedOn: 3,
        returnvalue: { coveragePercentage: 91 },
        progress: () => 0,
        getState: async () => 'completed',
      });

      const status = await service.status('42', 'user-1');

      expect(status.state).toBe('done');
      expect(status.result).toEqual({ coveragePercentage: 91 });
    });

    it('refuses a job belonging to another account', async () => {
      queue.getJob.mockResolvedValue({
        id: 42,
        data: { requestedBy: 'someone-else' },
        progress: () => 0,
        getState: async () => 'completed',
      });

      await expect(service.status('42', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an id that has been evicted by retention', async () => {
      queue.getJob.mockResolvedValue(null);
      await expect(service.status('999', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
