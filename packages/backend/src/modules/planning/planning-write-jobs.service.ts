/**
 * FAPOMS — Enqueue and poll side of the planning WRITE queue.
 *
 * The controller talks only to this for planning writes that run as jobs. The two rules that make
 * accept-and-poll safe — join an unfinished duplicate instead of starting a second run, and hand a
 * job only to the account that started it — are the shared ones: the duplicate rule through
 * `BackgroundJobsService.enqueueTracked` (which applies `findInFlightDuplicate`), the visibility rule
 * through `assertJobVisibleTo`.
 *
 * Every write is TRACKED: it stays on this queue, with its one loop and its stall setting, and is
 * also recorded on a `background_jobs` row so that a refreshed page and the Jobs tray can find a
 * deploy or a bulk offer that is still running. The Bull id is still what the poll route takes.
 */

import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

import {
  BulkOfferJobData,
  BulkUnableToCoverJobData,
  ExecutePlanJobData,
  GenerateVersionJobData,
  PLANNING_WRITE_JOB,
  PLANNING_WRITE_JOB_OPTIONS,
  PLANNING_WRITE_QUEUE,
} from './planning-write-jobs.contract';
import type { ScopeSnapshot } from './planning-jobs.contract';
import {
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';
import {
  BackgroundJobsService,
  type TrackedEnqueueResult,
} from '../../infrastructure/background-jobs/background-jobs.service';

/** Who asked, as the tracked row records it: the principal, and the regions they may read (null = all). */
export interface WriteJobRequester {
  actor: JobActor;
  regions: string[] | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

@Injectable()
export class PlanningWriteJobsService {
  constructor(
    @InjectQueue(PLANNING_WRITE_QUEUE) private readonly queue: Queue,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  /**
   * Deploy an approved plan.
   *
   * The fingerprint is the requester and the PLAN — not the start date. A plan deploys once;
   * pressing Deploy a second time while the first run is going, with or without having touched the
   * date picker, joins that run rather than queuing a second deploy behind it.
   */
  async enqueueExecutePlan(
    planId: string,
    scheduledDate: string | undefined,
    { actor, regions }: WriteJobRequester,
  ): Promise<TrackedEnqueueResult> {
    return this.backgroundJobs.enqueueTracked<ExecutePlanJobData>({
      kind: 'PLANNING_EXECUTE_PLAN',
      actor,
      regions,
      scope: { type: 'COVERAGE_PLAN', id: planId },
      title: scheduledDate ? `Deploy coverage plan from ${scheduledDate}` : 'Deploy coverage plan',
      params: { planId, scheduledDate: scheduledDate ?? null },
      queue: this.queue,
      jobName: PLANNING_WRITE_JOB.EXECUTE_PLAN,
      data: {
        planId,
        scheduledDate,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.EXECUTE_PLAN, actor.userId, { planId }),
      },
      options: PLANNING_WRITE_JOB_OPTIONS,
    });
  }

  async enqueueGenerateVersion(
    projectId: string,
    overrides: Array<Record<string, unknown>>,
    justification: string | undefined,
    { actor, regions }: WriteJobRequester,
  ): Promise<TrackedEnqueueResult> {
    const params = { projectId, overrides, justification };
    return this.backgroundJobs.enqueueTracked<GenerateVersionJobData>({
      kind: 'PLANNING_GENERATE_VERSION',
      actor,
      regions,
      scope: { type: 'PROJECT', id: projectId },
      title: 'Generate coverage plan',
      // The overrides themselves are the payload; the row keeps only how many there were.
      params: { projectId, overrides: overrides.length },
      queue: this.queue,
      jobName: PLANNING_WRITE_JOB.GENERATE_VERSION,
      data: {
        ...params,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.GENERATE_VERSION, actor.userId, params),
      },
      options: PLANNING_WRITE_JOB_OPTIONS,
    });
  }

  /** Branch ids are sorted into the fingerprint, so the same selection pressed twice is one run. */
  async enqueueBulkOffer(
    input: {
      projectBranchIds: string[];
      assayerId: string;
      assayerName?: string;
      scheduledDate?: string;
      acceptOnBehalf?: boolean;
      acceptanceReason?: string;
    },
    scope: ScopeSnapshot,
    { actor, regions }: WriteJobRequester,
  ): Promise<TrackedEnqueueResult> {
    const params = {
      projectBranchIds: [...new Set(input.projectBranchIds)].sort(),
      assayerId: input.assayerId,
      assayerName: input.assayerName,
      scheduledDate: input.scheduledDate,
      acceptOnBehalf: input.acceptOnBehalf === true,
      acceptanceReason: input.acceptanceReason,
      scope: scope ?? null,
    };
    const branches = params.projectBranchIds.length;
    return this.backgroundJobs.enqueueTracked<BulkOfferJobData>({
      kind: 'PLANNING_BULK_OFFER',
      actor,
      regions,
      title: `Offer ${plural(branches, 'branch', 'branches')} to ${params.assayerName || 'an assayer'}`,
      params: {
        branches,
        assayerId: params.assayerId,
        assayerName: params.assayerName ?? null,
        scheduledDate: params.scheduledDate ?? null,
        acceptOnBehalf: params.acceptOnBehalf,
      },
      total: branches,
      queue: this.queue,
      jobName: PLANNING_WRITE_JOB.BULK_OFFER,
      data: {
        ...params,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.BULK_OFFER, actor.userId, params),
      },
      options: PLANNING_WRITE_JOB_OPTIONS,
    });
  }

  async enqueueBulkUnableToCover(
    projectBranchIds: string[],
    reason: string,
    scope: ScopeSnapshot,
    { actor, regions }: WriteJobRequester,
  ): Promise<TrackedEnqueueResult> {
    const params = {
      projectBranchIds: [...new Set(projectBranchIds)].sort(),
      reason,
      scope: scope ?? null,
    };
    const branches = params.projectBranchIds.length;
    return this.backgroundJobs.enqueueTracked<BulkUnableToCoverJobData>({
      kind: 'PLANNING_BULK_UNABLE_TO_COVER',
      actor,
      regions,
      title: `Mark ${plural(branches, 'branch', 'branches')} unable to cover`,
      params: { branches, reason: reason.length > 200 ? `${reason.slice(0, 199)}…` : reason },
      total: branches,
      queue: this.queue,
      jobName: PLANNING_WRITE_JOB.BULK_UNABLE_TO_COVER,
      data: {
        ...params,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.BULK_UNABLE_TO_COVER, actor.userId, params),
      },
      options: PLANNING_WRITE_JOB_OPTIONS,
    });
  }

  /**
   * Poll one write job. A job id from the read queue is a different number space — these ids are
   * only meaningful on this queue, which is why the web polls a separate route for them.
   */
  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // The per-branch outcome is the deliverable, and it holds ids, dates and reasons only.
    return describeJob(job, { includeResult: true });
  }
}
