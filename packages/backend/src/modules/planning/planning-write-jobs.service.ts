/**
 * FAPOMS — Enqueue and poll side of the planning WRITE queue.
 *
 * The controller talks only to this for planning writes that run as jobs. The two rules that make
 * accept-and-poll safe — join an unfinished duplicate instead of starting a second run, and hand a
 * job only to the account that started it — are the same ones the read queue applies, through the
 * same helper (`enqueueOnce`) and the same check (`assertJobVisibleTo`).
 */

import { Injectable, Logger } from '@nestjs/common';
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
import { EnqueueResult, enqueueOnce } from './planning-jobs.service';
import {
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
} from '../../infrastructure/queue/queued-job';
import type { JobActor } from '../../infrastructure/queue/job-actor';

@Injectable()
export class PlanningWriteJobsService {
  private readonly logger = new Logger(PlanningWriteJobsService.name);

  constructor(@InjectQueue(PLANNING_WRITE_QUEUE) private readonly queue: Queue) {}

  /**
   * Deploy an approved plan.
   *
   * The fingerprint is the requester and the PLAN — not the start date. A plan deploys once;
   * pressing Deploy a second time while the first run is going, with or without having touched the
   * date picker, joins that run rather than queuing a second deploy behind it.
   */
  async enqueueExecutePlan(planId: string, scheduledDate: string | undefined, actor: JobActor): Promise<EnqueueResult> {
    return enqueueOnce<ExecutePlanJobData>(
      this.queue,
      PLANNING_WRITE_JOB.EXECUTE_PLAN,
      {
        planId,
        scheduledDate,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.EXECUTE_PLAN, actor.userId, { planId }),
      },
      PLANNING_WRITE_JOB_OPTIONS,
      this.logger,
    );
  }

  async enqueueGenerateVersion(
    projectId: string,
    overrides: Array<Record<string, unknown>>,
    justification: string | undefined,
    actor: JobActor,
  ): Promise<EnqueueResult> {
    const params = { projectId, overrides, justification };
    return enqueueOnce<GenerateVersionJobData>(
      this.queue,
      PLANNING_WRITE_JOB.GENERATE_VERSION,
      {
        ...params,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.GENERATE_VERSION, actor.userId, params),
      },
      PLANNING_WRITE_JOB_OPTIONS,
      this.logger,
    );
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
    actor: JobActor,
  ): Promise<EnqueueResult> {
    const params = {
      projectBranchIds: [...new Set(input.projectBranchIds)].sort(),
      assayerId: input.assayerId,
      assayerName: input.assayerName,
      scheduledDate: input.scheduledDate,
      acceptOnBehalf: input.acceptOnBehalf === true,
      acceptanceReason: input.acceptanceReason,
      scope: scope ?? null,
    };
    return enqueueOnce<BulkOfferJobData>(
      this.queue,
      PLANNING_WRITE_JOB.BULK_OFFER,
      {
        ...params,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.BULK_OFFER, actor.userId, params),
      },
      PLANNING_WRITE_JOB_OPTIONS,
      this.logger,
    );
  }

  async enqueueBulkUnableToCover(
    projectBranchIds: string[],
    reason: string,
    scope: ScopeSnapshot,
    actor: JobActor,
  ): Promise<EnqueueResult> {
    const params = {
      projectBranchIds: [...new Set(projectBranchIds)].sort(),
      reason,
      scope: scope ?? null,
    };
    return enqueueOnce<BulkUnableToCoverJobData>(
      this.queue,
      PLANNING_WRITE_JOB.BULK_UNABLE_TO_COVER,
      {
        ...params,
        actor,
        requestedBy: actor.userId,
        dedupeKey: dedupeKeyFor(PLANNING_WRITE_JOB.BULK_UNABLE_TO_COVER, actor.userId, params),
      },
      PLANNING_WRITE_JOB_OPTIONS,
      this.logger,
    );
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
