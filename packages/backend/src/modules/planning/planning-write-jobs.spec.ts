import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'fs';
import { join } from 'path';

import { PlanningController } from './planning.controller';
import { PlanningWriteJobsService } from './planning-write-jobs.service';
import { PlanningWriteJobsWorker, refusalOf } from './planning-write-jobs.worker';
import {
  PLANNING_WRITE_JOB,
  PLANNING_WRITE_JOB_OPTIONS,
  PLANNING_WRITE_QUEUE_SETTINGS,
} from './planning-write-jobs.contract';
import { getRequestContext } from '../../core/context/request-context';
import { BackgroundJobsService } from '../../infrastructure/background-jobs/background-jobs.service';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';
import { BackgroundJobRegistry } from '../../infrastructure/background-jobs/background-job.registry';
import type { BackgroundJobEntity } from '../../infrastructure/background-jobs/background-job.entity';

/**
 * PLANNING WRITES ARE ACCEPTED, RUN ONCE, AND RUN AS THE PERSON WHO PRESSED THE BUTTON.
 *
 * Deploying a coverage plan created every assignment inside the request — 166 branches at up to half
 * a second each is past the web client's 30 s, so the screen said "failed" while the server carried
 * on, and a second press started a second deploy. The desk's bulk offer and bulk unable-to-cover
 * were browser loops of one POST per branch, past the per-user rate limit at 500 ticks, with the
 * refused ones reported as a bare name. These pin what makes moving them onto a queue safe: the
 * request only accepts; a second press joins the run; nothing retries or re-runs by itself; one
 * branch's refusal is that branch's, stated in its own words; and nobody else can read the result.
 */

const ACTOR = { userId: 'ops-1', roleNames: ['OPERATIONS'], organizationId: 'org-1', displayName: 'Meera' };

function queueWith(jobs: any[] = []) {
  let n = 0;
  return {
    name: 'planning-write-jobs',
    add: jest.fn(async (name: string, data: any, opts: any = {}) => {
      const job = { id: String(++n), name, data, opts, state: 'waiting', attemptsMade: 0, progress: jest.fn(async () => undefined) };
      jobs.push(job);
      return job;
    }),
    getJobs: jest.fn(async (states: string[] = ['waiting', 'active', 'delayed']) => jobs.filter((j) => states.includes(j.state))),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
  };
}

/**
 * The rows the Jobs tray reads, without Postgres: only what `enqueueTracked` and the tracker touch,
 * with the store's conditional transitions (a row only moves from the states it names).
 */
class FakeRows {
  rows = new Map<string, BackgroundJobEntity>();
  private seq = 0;
  private get(id: string) { const r = this.rows.get(id); return r ? ({ ...r } as BackgroundJobEntity) : null; }
  async insert(values: Partial<BackgroundJobEntity>) {
    const row = { id: `row-${++this.seq}`, attempts: 0, bullJobId: null, result: null, error: null, createdAt: new Date(), updatedAt: new Date(), ...values } as BackgroundJobEntity;
    this.rows.set(row.id, row);
    return { job: this.get(row.id)!, inserted: true };
  }
  async findById(id: string) { return this.get(id); }
  async setBullJobId(id: string, bullJobId: string) { Object.assign(this.rows.get(id)!, { bullJobId }); }
  async claim(id: string) {
    const r = this.rows.get(id);
    if (!r || !['QUEUED', 'RUNNING'].includes(r.status)) return null;
    Object.assign(r, { status: 'RUNNING', attempts: r.attempts + 1, startedAt: new Date() });
    return this.get(id);
  }
  async transition(id: string, from: string[], patch: Partial<BackgroundJobEntity>) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return null;
    Object.assign(r, patch);
    return this.get(id);
  }
  async writeProgress(id: string, progress: any) {
    const r = this.rows.get(id);
    if (!r || r.status !== 'RUNNING') return false;
    r.progress = progress;
    return true;
  }
  async patch(id: string, patch: Partial<BackgroundJobEntity>) { Object.assign(this.rows.get(id)!, patch); }
}

/** The real enqueue and worker halves of tracking, over the fake rows. */
function tracking() {
  const rows = new FakeRows();
  const events = { publish: jest.fn() };
  const service = new BackgroundJobsService(rows as any, new BackgroundJobRegistry(), { add: jest.fn() } as any, {} as any, events as any);
  const tracker = new BackgroundJobTracker(rows as any, service, {} as any);
  jest.spyOn(service, 'enqueueTracked');
  return { rows, events, service, tracker };
}

const REQUESTER = { actor: ACTOR, regions: null };

const stripped = (file: string) => readFileSync(join(__dirname, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('POST /planning/coverage-plans/:planId/execute', () => {
  const build = () => {
    const operations = { executeApprovedPlan: jest.fn() };
    const regionGuard = { assertCoveragePlanInScope: jest.fn(async () => undefined) };
    const writeJobs = { enqueueExecutePlan: jest.fn(async () => ({ jobId: '7', deduplicated: false, backgroundJobId: 'row-1' })) };
    const controller = new PlanningController(
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      operations as any, {} as any, {} as any, regionGuard as any, writeJobs as any,
    );
    return { controller, operations, regionGuard, writeJobs };
  };
  const req = { user: { id: 'ops-1', roles: [{ name: 'OPERATIONS' }], organizationId: 'org-1', displayName: 'Meera' } };

  /**
   * The request that used to create 166 assignments now creates none. If it ever calls the executor
   * again, a large plan is back to failing on screen while it deploys behind the operator's back.
   */
  it('enqueues the deploy and answers 202 with a job id, creating nothing itself', async () => {
    const { controller, operations, regionGuard, writeJobs } = build();

    const res = await controller.executePlan('plan-1', { scheduledDate: '2026-10-01' }, req, { regions: ['WEST'] } as any);

    expect(res).toEqual({ jobId: '7', deduplicated: false, backgroundJobId: 'row-1' });
    expect(operations.executeApprovedPlan).not.toHaveBeenCalled();
    expect(writeJobs.enqueueExecutePlan).toHaveBeenCalledWith('plan-1', '2026-10-01', { actor: ACTOR, regions: null });
    expect(regionGuard.assertCoveragePlanInScope).toHaveBeenCalledWith('plan-1', { regions: ['WEST'] });
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, PlanningController.prototype.executePlan)).toBe(202);
  });

  /** The tracked row records the requester's regions, so an administrator's tray view stays region-bounded. */
  it('hands the queue the requester\'s own regions for the tracked row', async () => {
    const { controller, writeJobs } = build();
    const regional = { user: { ...req.user, regions: ['WEST'] } };

    await controller.executePlan('plan-1', {}, regional, { regions: ['WEST'] } as any);

    expect(writeJobs.enqueueExecutePlan).toHaveBeenCalledWith('plan-1', undefined, { actor: ACTOR, regions: ['WEST'] });
  });

  /** The region check is the request's; a refused plan must not reach the queue at all. */
  it('refuses a plan outside the caller\'s region before anything is queued', async () => {
    const { controller, regionGuard, writeJobs } = build();
    regionGuard.assertCoveragePlanInScope.mockRejectedValueOnce(new ForbiddenException('Not your region'));

    await expect(controller.executePlan('plan-1', {}, req, { regions: ['EAST'] } as any)).rejects.toThrow('Not your region');
    expect(writeJobs.enqueueExecutePlan).not.toHaveBeenCalled();
  });
});

describe('PlanningWriteJobsService', () => {
  /**
   * The double press that used to start a second deploy. Keyed on the requester and the plan only,
   * so touching the date picker between presses does not make it a different deploy.
   */
  it('joins the deploy already running when the same person presses Deploy again, whatever the date', async () => {
    const queue = queueWith();
    const { service: jobs, rows } = tracking();
    const service = new PlanningWriteJobsService(queue as any, jobs);

    const first = await service.enqueueExecutePlan('plan-1', '2026-10-01', REQUESTER);
    const second = await service.enqueueExecutePlan('plan-1', '2026-10-05', REQUESTER);

    expect(first).toEqual({ jobId: '1', deduplicated: false, backgroundJobId: 'row-1' });
    expect(second).toEqual({ jobId: '1', deduplicated: true, backgroundJobId: 'row-1' });
    expect(queue.add).toHaveBeenCalledTimes(1);
    // One run, one row: the second press joined it and wrote nothing.
    expect(rows.rows.size).toBe(1);
  });

  it('queues a separate deploy for a different plan', async () => {
    const queue = queueWith();
    const service = new PlanningWriteJobsService(queue as any, tracking().service);

    await service.enqueueExecutePlan('plan-1', undefined, REQUESTER);
    const other = await service.enqueueExecutePlan('plan-2', undefined, REQUESTER);

    expect(other.deduplicated).toBe(false);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  /** A write retried after a part-way failure re-offers what it already offered. */
  it('never retries a write, and bounds what it keeps', async () => {
    const queue = queueWith();
    const service = new PlanningWriteJobsService(queue as any, tracking().service);

    await service.enqueueBulkOffer({ projectBranchIds: ['b', 'a', 'b'], assayerId: 'as-1' }, null, REQUESTER);

    const [name, data, opts] = queue.add.mock.calls[0] as any[];
    expect(name).toBe(PLANNING_WRITE_JOB.BULK_OFFER);
    expect(data.projectBranchIds).toEqual(['a', 'b']);
    expect(data.requestedBy).toBe('ops-1');
    expect(opts).toBe(PLANNING_WRITE_JOB_OPTIONS);
    expect(opts.attempts).toBe(1);
    expect(opts.removeOnComplete).not.toBe(false);
    expect(opts.removeOnFail).not.toBe(false);
  });

  /**
   * Job ids count up from 1 — `/planning/write-jobs/2` is a guess, not an exploit. The result names
   * branches, assignments and dates in the requester's region, so anyone else gets a 404.
   */
  it('answers 404 to anyone but the account that started the job', async () => {
    const queue = queueWith();
    const service = new PlanningWriteJobsService(queue as any, tracking().service);
    const { jobId } = await service.enqueueExecutePlan('plan-1', undefined, REQUESTER);
    const stored = (await queue.getJob(jobId)) as any;
    Object.assign(stored, { progress: () => 0, getState: async () => 'waiting' });

    await expect(service.status(jobId, 'someone-else')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status(jobId, undefined)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.status(jobId, 'ops-1')).resolves.toMatchObject({ jobId, state: 'queued' });
  });
});

describe('PlanningWriteJobsWorker', () => {
  const job = (name: string, data: any) => ({ id: '3', name, data, progress: jest.fn(async () => undefined) }) as any;

  const build = () => {
    const operations = {
      executeApprovedPlan: jest.fn(async (..._args: any[]): Promise<any> => ({
        deployed: [{ branchId: 'b-1', assignmentId: 'asg-1', scheduledDate: '2026-10-01' }],
        skipped: [],
        skippedReasons: [],
        fullySkipped: false,
        dateRange: { start: '2026-10-01', end: '2026-10-01' },
        alreadyDeployedCount: 0,
      })),
      createOrRegeneratePlan: jest.fn(async () => ({ id: 'plan-1', status: 'GENERATED', currentVersion: 2 })),
    };
    const assignments = { create: jest.fn() };
    const projects = { markBranchUnableToCover: jest.fn(async () => ({})) };
    const regionGuard = { assertProjectBranchInScope: jest.fn(async () => undefined) };
    const { tracker } = tracking();
    const worker = new PlanningWriteJobsWorker(operations as any, assignments as any, projects as any, regionGuard as any, tracker);
    return { worker, operations, assignments, projects, regionGuard };
  };

  /**
   * The deploy's result is the body the synchronous route used to return, so the screen reads the
   * same fields. It runs as the requester: tenant scoping and audit rows read that ambient context.
   */
  it('deploys as the requester, reports progress, and returns the old response shape', async () => {
    const { worker, operations } = build();
    let seenUser: string | undefined;
    operations.executeApprovedPlan.mockImplementationOnce(async (...args: any[]) => {
      seenUser = getRequestContext()?.userId;
      await args[3](1, 2, 'Creating offers');
      return {
        deployed: [{ branchId: 'b-1', assignmentId: 'asg-1', scheduledDate: '2026-10-01' }],
        skipped: [{ clusterId: 'c-1', branchId: 'b-2', reason: 'No fee' }],
        skippedReasons: [{ reason: 'No fee', count: 1 }],
        fullySkipped: false,
        dateRange: { start: '2026-10-01', end: '2026-10-01' },
        alreadyDeployedCount: 0,
      };
    });
    const j = job(PLANNING_WRITE_JOB.EXECUTE_PLAN, { planId: 'plan-1', scheduledDate: '2026-10-01', actor: ACTOR });

    const result = await worker.run(j);

    expect(operations.executeApprovedPlan).toHaveBeenCalledWith('plan-1', 'ops-1', '2026-10-01', expect.any(Function));
    expect(seenUser).toBe('ops-1');
    expect(j.progress).toHaveBeenCalledWith({ percent: 50, stage: 'Creating offers (1/2)' });
    expect(result).toMatchObject({
      deployedCount: 1,
      skippedCount: 1,
      deployed: [{ branchId: 'b-1', assignmentId: 'asg-1', scheduledDate: '2026-10-01' }],
      skippedReasons: [{ reason: 'No fee', count: 1 }],
      fullySkipped: false,
      dateRange: { start: '2026-10-01', end: '2026-10-01' },
    });
    expect((result as any).message).toMatch(/1 assignment\(s\) created, 1 skipped/);
  });

  /**
   * The browser loop's failure: some branches were refused (429) and reported as a name. Here every
   * branch lands in exactly one list, a refusal carries its own words, and the run goes on.
   */
  it('offers each branch on its own, keeping one refusal from costing the others', async () => {
    const { worker, assignments, regionGuard } = build();
    assignments.create
      .mockResolvedValueOnce({ id: 'asg-a', status: 'PENDING' })
      .mockRejectedValueOnce(new ConflictException('Branch Busy: An active assignment already exists.'))
      .mockResolvedValueOnce({ id: 'asg-c', status: 'ACCEPTED' });
    const j = job(PLANNING_WRITE_JOB.BULK_OFFER, {
      projectBranchIds: ['pb-a', 'pb-b', 'pb-c'], assayerId: 'as-1', assayerName: 'Ravi',
      acceptOnBehalf: true, acceptanceReason: 'Agreed by phone', scope: { regions: ['WEST'] }, actor: ACTOR,
    });

    const result = await worker.run(j);

    expect(result).toEqual({
      succeeded: [
        { projectBranchId: 'pb-a', assignmentId: 'asg-a', status: 'PENDING' },
        { projectBranchId: 'pb-c', assignmentId: 'asg-c', status: 'ACCEPTED' },
      ],
      failed: [{ projectBranchId: 'pb-b', error: 'Branch Busy: An active assignment already exists.' }],
    });
    expect(assignments.create).toHaveBeenCalledWith(expect.objectContaining({
      projectBranchId: 'pb-a', assayerId: 'as-1', acceptOnBehalf: true, acceptanceReason: 'Agreed by phone',
      remarks: 'Bulk-assigned to Ravi from the planning queue',
    }), 'ops-1');
    expect(regionGuard.assertProjectBranchInScope).toHaveBeenCalledTimes(3);
    expect(j.progress).toHaveBeenCalledWith({ percent: 67, stage: 'Offering branches (2/3)' });
  });

  /** A batch must not be a way around the region check a single `POST /assignments` meets. */
  it('refuses a branch outside the requester\'s region without writing it, and records why', async () => {
    const { worker, assignments, projects, regionGuard } = build();
    regionGuard.assertProjectBranchInScope
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ForbiddenException('That record belongs to a region your account is not assigned to'));

    const result = await worker.run(job(PLANNING_WRITE_JOB.BULK_UNABLE_TO_COVER, {
      projectBranchIds: ['pb-a', 'pb-b'], reason: 'No assayer within 200 km', scope: { regions: ['WEST'] }, actor: ACTOR,
    }));

    expect(projects.markBranchUnableToCover).toHaveBeenCalledTimes(1);
    expect(projects.markBranchUnableToCover).toHaveBeenCalledWith('pb-a', 'ops-1', 'No assayer within 200 km');
    expect(assignments.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      succeeded: [{ projectBranchId: 'pb-a' }],
      failed: [{ projectBranchId: 'pb-b', error: 'That record belongs to a region your account is not assigned to' }],
    });
  });

  /**
   * Owner decision 2026-09-25: a rule the bulk offer would be refused on (rotation, the client's
   * required skills) is waived by a reason typed ONCE for the batch, recorded per offer by create().
   * Without one, nothing is waived.
   */
  it('hands the bulk override reason to every offer, and only when one was given', async () => {
    const { worker, assignments } = build();
    assignments.create.mockResolvedValue({ id: 'asg', status: 'PENDING' });
    await worker.run(job(PLANNING_WRITE_JOB.BULK_OFFER, {
      projectBranchIds: ['pb-a', 'pb-b'], assayerId: 'as-1', acceptOnBehalf: false,
      overrideReason: 'Only certified assayer in the district', scope: null, actor: ACTOR,
    }));
    expect(assignments.create.mock.calls.map((c: any[]) => c[0].overrideReason)).toEqual([
      'Only certified assayer in the district', 'Only certified assayer in the district',
    ]);

    assignments.create.mockClear();
    await worker.run(job(PLANNING_WRITE_JOB.BULK_OFFER, {
      projectBranchIds: ['pb-a'], assayerId: 'as-1', acceptOnBehalf: false, scope: null, actor: ACTOR,
    }));
    expect(assignments.create.mock.calls[0][0]).not.toHaveProperty('overrideReason');
  });

  /** F19 / F1: the version is generated under the scope and start date frozen at the request. */
  it('generates a version with the requester\'s scope and start date', async () => {
    const { worker, operations } = build();
    const scope = { regions: ['WEST'] };
    await worker.run(job(PLANNING_WRITE_JOB.GENERATE_VERSION, {
      projectId: 'proj-1', overrides: [], justification: 'x', scope, startDate: '2026-10-05', actor: ACTOR,
    }));
    expect(operations.createOrRegeneratePlan).toHaveBeenCalledWith(
      'proj-1', [], 'ops-1', 'x', expect.any(Function), { scope, startDate: '2026-10-05' },
    );
  });

  it('refuses a job name it does not know rather than completing it with no result', async () => {
    const { worker } = build();
    await expect(worker.run(job('mystery', { actor: ACTOR }))).rejects.toThrow(/No handler/);
  });

  it('states a validation refusal in its own words, not as "Failed"', () => {
    const err = { getResponse: () => ({ message: ['scheduledDate must be a date', 'fee is too high'] }) };
    expect(refusalOf(err)).toBe('scheduledDate must be a date; fee is too high');
    expect(refusalOf(new Error('Holiday Conflict: 2 Oct'))).toBe('Holiday Conflict: 2 Oct');
  });
});

/**
 * EVERY PLANNING WRITE IS FINDABLE AFTER A REFRESH.
 *
 * A deploy or a 400-branch bulk offer runs for minutes. The page follows it by polling a Bull id it
 * holds in memory, so a refresh used to lose it: the run carried on, and the operator could not see
 * that it had, nor how it ended. Each write is now recorded on a `background_jobs` row (the Jobs
 * tray's list) while staying on its own queue, with its duplicate rule and its poll unchanged.
 */
describe('tracked planning writes', () => {
  const REGIONAL = { actor: ACTOR, regions: ['WEST'] };
  const pbs = ['pb-2', 'pb-1', 'pb-3'];

  const operations = () => ({
    executeApprovedPlan: jest.fn(async (_p: string, _u: string, _d: string | undefined, onProgress: any) => {
      await onProgress(1, 2, 'Creating offers');
      return {
        deployed: [{ branchId: 'b-1', assignmentId: 'asg-1', scheduledDate: '2026-10-01' }],
        skipped: [{ clusterId: 'c-1', branchId: 'b-2', reason: 'No fee' }],
        skippedReasons: [{ reason: 'No fee', count: 1 }],
        fullySkipped: false,
        dateRange: { start: '2026-10-01', end: '2026-10-01' },
        alreadyDeployedCount: 0,
      };
    }),
    createOrRegeneratePlan: jest.fn(async () => ({ id: 'plan-1', status: 'GENERATED', currentVersion: 2 })),
  });

  const cases: Array<{
    kind: string;
    enqueue: (s: PlanningWriteJobsService) => Promise<any>;
    title: string;
    scope: { type: string; id: string } | null;
    params: Record<string, unknown>;
    total: number | null;
    summary: string;
    counts: Record<string, number>;
  }> = [
    {
      kind: 'PLANNING_EXECUTE_PLAN',
      enqueue: (s) => s.enqueueExecutePlan('plan-1', '2026-10-01', REGIONAL),
      title: 'Deploy coverage plan from 2026-10-01',
      scope: { type: 'COVERAGE_PLAN', id: 'plan-1' },
      params: { planId: 'plan-1', scheduledDate: '2026-10-01' },
      total: null,
      summary: 'Coverage plan deployed: 1 assignment(s) created, 1 skipped across 2026-10-01 → 2026-10-01.',
      counts: { deployed: 1, skipped: 1, alreadyDeployed: 0 },
    },
    {
      kind: 'PLANNING_GENERATE_VERSION',
      enqueue: (s) => s.enqueueGenerateVersion('proj-1', [{ branchId: 'b-1' }], 'Monsoon', REGIONAL),
      title: 'Generate coverage plan',
      scope: { type: 'PROJECT', id: 'proj-1' },
      params: { projectId: 'proj-1', overrides: 1 },
      total: null,
      summary: 'Coverage plan version 2 generated (generated).',
      counts: { version: 2 },
    },
    {
      kind: 'PLANNING_BULK_OFFER',
      enqueue: (s) => s.enqueueBulkOffer({ projectBranchIds: pbs, assayerId: 'as-1', assayerName: 'Ravi' }, { regions: ['WEST'] } as any, REGIONAL),
      title: 'Offer 3 branches to Ravi',
      scope: null,
      params: { branches: 3, assayerId: 'as-1', assayerName: 'Ravi', scheduledDate: null, acceptOnBehalf: false },
      total: 3,
      summary: '2 of 3 branches offered to Ravi; 1 refused.',
      counts: { offered: 2, refused: 1 },
    },
    {
      kind: 'PLANNING_BULK_UNABLE_TO_COVER',
      enqueue: (s) => s.enqueueBulkUnableToCover(pbs, 'No assayer within 200 km', { regions: ['WEST'] } as any, REGIONAL),
      title: 'Mark 3 branches unable to cover',
      scope: null,
      params: { branches: 3, reason: 'No assayer within 200 km' },
      total: 3,
      summary: '3 branches marked unable to cover.',
      counts: { recorded: 3, refused: 0 },
    },
  ];

  it.each(cases)('$kind: the enqueue writes one tracked row, and an identical press joins it', async (c) => {
    const queue = queueWith();
    const { service: jobs, rows } = tracking();
    const service = new PlanningWriteJobsService(queue as any, jobs);

    const first = await c.enqueue(service);
    const again = await c.enqueue(service);

    expect(jobs.enqueueTracked).toHaveBeenCalledWith(expect.objectContaining({
      kind: c.kind, title: c.title, actor: ACTOR, regions: ['WEST'], queue, options: PLANNING_WRITE_JOB_OPTIONS,
    }));
    expect(first).toEqual({ jobId: '1', deduplicated: false, backgroundJobId: 'row-1' });
    expect(again).toEqual({ jobId: '1', deduplicated: true, backgroundJobId: 'row-1' });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(rows.rows.size).toBe(1);

    const row = rows.rows.get('row-1')!;
    expect(row).toMatchObject({
      kind: c.kind, status: 'QUEUED', title: c.title, requestedBy: 'ops-1', regions: ['WEST'],
      scopeType: c.scope?.type ?? null, scopeId: c.scope?.id ?? null, params: c.params, bullJobId: '1',
      runnerQueue: 'planning-write-jobs',
    });
    expect(row.progress.total).toBe(c.total);
    // The Bull payload is the feature's own, plus the row id — the worker's inputs are unchanged.
    expect(queue.add.mock.calls[0][1]).toMatchObject({ requestedBy: 'ops-1', actor: ACTOR, backgroundJobId: 'row-1' });
  });

  it.each(cases)('$kind: the worker runs through the tracker — row SUCCEEDED with its summary, Bull result unchanged', async (c) => {
    const queue = queueWith();
    const { service: jobs, rows, tracker } = tracking();
    const service = new PlanningWriteJobsService(queue as any, jobs);
    const ops = operations();
    const assignments = {
      create: jest.fn()
        .mockResolvedValueOnce({ id: 'asg-1', status: 'PENDING' })
        .mockRejectedValueOnce(new ConflictException('Branch Busy'))
        .mockResolvedValueOnce({ id: 'asg-3', status: 'PENDING' }),
    };
    const projects = { markBranchUnableToCover: jest.fn(async () => ({})) };
    const regionGuard = { assertProjectBranchInScope: jest.fn(async () => undefined) };
    const worker = new PlanningWriteJobsWorker(ops as any, assignments as any, projects as any, regionGuard as any, tracker);
    const untrackedWorker = new PlanningWriteJobsWorker(
      operations() as any,
      { create: jest.fn().mockResolvedValueOnce({ id: 'asg-1', status: 'PENDING' }).mockRejectedValueOnce(new ConflictException('Branch Busy')).mockResolvedValueOnce({ id: 'asg-3', status: 'PENDING' }) } as any,
      { markBranchUnableToCover: jest.fn(async () => ({})) } as any,
      regionGuard as any,
      tracker,
    );

    await c.enqueue(service);
    const bull = (await queue.getJob('1')) as any;
    const result = await worker.run(bull);

    const row = rows.rows.get('row-1')!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.result).toEqual({ summary: c.summary, counts: c.counts });
    expect(row.progress).toMatchObject({ percent: 100, stage: 'Done' });
    // What the poll route hands the page is exactly what an untracked run returns.
    const { backgroundJobId: _dropped, ...untrackedData } = bull.data;
    expect(result).toEqual(await untrackedWorker.run({ ...bull, data: untrackedData, progress: jest.fn(async () => undefined) }));
    expect(bull.progress).toHaveBeenCalled();
  });

  it('a write that throws leaves a FAILED row in the operator\'s words, and still fails the Bull job', async () => {
    const queue = queueWith();
    const { service: jobs, rows, tracker } = tracking();
    const service = new PlanningWriteJobsService(queue as any, jobs);
    const ops = operations();
    ops.executeApprovedPlan.mockRejectedValueOnce(new ConflictException('Execution denied: only APPROVED plans can be deployed.'));
    const worker = new PlanningWriteJobsWorker(ops as any, {} as any, {} as any, {} as any, tracker);

    await service.enqueueExecutePlan('plan-1', undefined, REQUESTER);
    await expect(worker.run((await queue.getJob('1')) as any)).rejects.toThrow('Execution denied');

    expect(rows.rows.get('row-1')).toMatchObject({ status: 'FAILED', error: expect.stringContaining('Execution denied') });
  });
});

describe('one planning write at a time, and never re-run by itself', () => {
  /**
   * Bull's loops belong to the queue and take jobs of any name. A handler per job name would be a
   * loop per name, and two deploys of the same plan could run side by side.
   */
  it('has exactly one processing loop on the write queue', () => {
    const handlers = [...stripped('planning-write-jobs.worker.ts').matchAll(/@Process\(([^)]*)\)/g)].map((m) => m[1]);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatch(/name:\s*'\*'/);
    expect(handlers[0]).toMatch(/concurrency:\s*1\b/);
  });

  /**
   * `attempts: 1` does not stop Bull restarting a job whose worker died — stalled recovery is its own
   * counter. A bulk offer restarted from the top re-offers, and re-notifies, every branch it had done.
   */
  it('fails a run whose worker died instead of restarting it from the top', () => {
    expect(PLANNING_WRITE_QUEUE_SETTINGS.maxStalledCount).toBe(0);
    const module = stripped('planning.module.ts');
    const registration = module.slice(module.indexOf('name: PLANNING_WRITE_QUEUE'));
    expect(registration.slice(0, registration.indexOf('})'))).toMatch(/settings:\s*PLANNING_WRITE_QUEUE_SETTINGS\b/);
  });
});
