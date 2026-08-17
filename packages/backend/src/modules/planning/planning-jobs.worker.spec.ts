import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { PlanningJobsWorker } from './planning-jobs.worker';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { ProjectPlanningService } from './project-planning.service';
import { DayPlannerService } from './day-planner.service';
import { PLANNING_JOB, PLANNING_QUEUE } from './planning-jobs.contract';

/** @nestjs/bull's own metadata keys — see node_modules/@nestjs/bull/dist/bull.constants.js. */
const BULL_MODULE_QUEUE = 'bull:module_queue';
const BULL_MODULE_QUEUE_PROCESS = 'bull:module_queue_process';

function jobStub(data: Record<string, unknown>) {
  return {
    id: 5,
    name: 'test',
    data,
    progress: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('PlanningJobsWorker', () => {
  let worker: PlanningJobsWorker;

  const coveragePlanningEngine = { generateCoveragePlan: jest.fn() };
  const projectPlanningService = { getProjectPlanningCandidates: jest.fn() };
  const dayPlannerService = { generateDayPlans: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningJobsWorker,
        { provide: CoveragePlanningEngine, useValue: coveragePlanningEngine },
        { provide: ProjectPlanningService, useValue: projectPlanningService },
        { provide: DayPlannerService, useValue: dayPlannerService },
      ],
    }).compile();

    worker = module.get(PlanningJobsWorker);
    jest.clearAllMocks();
    coveragePlanningEngine.generateCoveragePlan.mockResolvedValue({ coveragePercentage: 90, clusters: [] });
    projectPlanningService.getProjectPlanningCandidates.mockResolvedValue({ branches: [] });
    dayPlannerService.generateDayPlans.mockResolvedValue({ clusters: [] });
  });

  /**
   * The regression this whole block exists for.
   *
   * On the shared 'background-jobs' queue, `BullQueueManager` adds jobs with a name while
   * `BullProcessor` declares a bare `@Process()`. In Bull a bare handler is registered under the
   * reserved name `__default__` and matches ONLY jobs added without a name, so every job that
   * manager enqueues has no handler and eventually stalls — and nothing in the type system
   * catches it, because both halves compile perfectly. Reading the decorator metadata back is
   * the only way to assert the two halves agree.
   */
  describe('handler registration', () => {
    it('is attached to the planning queue', () => {
      expect(Reflect.getMetadata(BULL_MODULE_QUEUE, PlanningJobsWorker)).toMatchObject({ name: PLANNING_QUEUE });
    });

    it.each([
      ['coveragePlan', PLANNING_JOB.COVERAGE_PLAN],
      ['projectCandidates', PLANNING_JOB.PROJECT_CANDIDATES],
      ['dayPlans', PLANNING_JOB.DAY_PLANS],
    ])('registers %s under the exact name the enqueue side uses', (method, expectedName) => {
      const meta = Reflect.getMetadata(BULL_MODULE_QUEUE_PROCESS, (PlanningJobsWorker.prototype as any)[method]);

      expect(meta).toBeDefined();
      expect(meta.name).toBe(expectedName);
      // A handler with no name is the 'background-jobs' defect exactly.
      expect(meta.name).toBeTruthy();
    });

    it.each(['coveragePlan', 'projectCandidates', 'dayPlans'])(
      'runs %s one at a time',
      (method) => {
        // This processor lives inside the API process: the CPU a plan burns is CPU the request
        // handlers are not getting. Concurrency 1 is what makes "the queue protects the API" a
        // guarantee rather than a slogan.
        const meta = Reflect.getMetadata(BULL_MODULE_QUEUE_PROCESS, (PlanningJobsWorker.prototype as any)[method]);
        expect(meta.concurrency).toBe(1);
      },
    );
  });

  describe('coveragePlan', () => {
    it('passes the payload scope through to the engine unchanged', async () => {
      const scope = { regions: ['WEST'], state: 'MH' };
      await worker.coveragePlan(jobStub({ projectId: 'p-1', scope }));

      expect(coveragePlanningEngine.generateCoveragePlan).toHaveBeenCalledWith(
        'p-1',
        scope,
        expect.any(Function),
      );
    });

    it('turns a null scope into undefined so the engine sees "unscoped", not "scope {}"', async () => {
      await worker.coveragePlan(jobStub({ projectId: 'p-1', scope: null }));
      expect(coveragePlanningEngine.generateCoveragePlan).toHaveBeenCalledWith('p-1', undefined, expect.any(Function));
    });

    it('writes an opening stage before the first query', async () => {
      // The engine loads the project and the whole assayer roster before it can count anything.
      // A bar left at 0% with no label for those seconds reads as a stalled job.
      const job = jobStub({ projectId: 'p-1', scope: null });
      await worker.coveragePlan(job);

      expect(job.progress).toHaveBeenCalledWith({ percent: 0, stage: 'Loading project and workforce' });
    });

    it('returns the plan as the job result', async () => {
      const result = await worker.coveragePlan(jobStub({ projectId: 'p-1', scope: null }));
      expect(result).toEqual({ coveragePercentage: 90, clusters: [] });
    });

    it('reports per-branch progress through the callback it hands the engine', async () => {
      const job = jobStub({ projectId: 'p-1', scope: null });
      coveragePlanningEngine.generateCoveragePlan.mockImplementation(async (_id, _scope, onProgress) => {
        await onProgress(50, 200, 'Scoring branches');
        return { coveragePercentage: 90, clusters: [] };
      });

      await worker.coveragePlan(job);

      expect(job.progress).toHaveBeenCalledWith({ percent: 25, stage: 'Scoring branches (50/200)' });
    });

    it('lets a failure reach Bull so the poll endpoint can report it', async () => {
      // Swallowing it here would produce a job that reports success and a result of undefined.
      coveragePlanningEngine.generateCoveragePlan.mockRejectedValue(new Error('Project p-1 not found.'));
      await expect(worker.coveragePlan(jobStub({ projectId: 'p-1', scope: null }))).rejects.toThrow(
        'Project p-1 not found.',
      );
    });
  });

  describe('projectCandidates', () => {
    it('calls the same service the synchronous route calls, with the same arguments', async () => {
      const scope = { regions: null };
      await worker.projectCandidates(jobStub({ projectId: 'p-2', scope }));

      expect(projectPlanningService.getProjectPlanningCandidates).toHaveBeenCalledWith(
        'p-2',
        scope,
        expect.any(Function),
      );
    });
  });

  describe('dayPlans', () => {
    it('forwards the id list, date and minimum distance', async () => {
      await worker.dayPlans(jobStub({ projectIds: ['p-1', 'p-2'], targetDate: '2026-09-01', minDistanceKm: 12 }));

      expect(dayPlannerService.generateDayPlans).toHaveBeenCalledWith(
        ['p-1', 'p-2'],
        '2026-09-01',
        12,
        expect.any(Function),
      );
    });
  });
});
