/**
 * FAPOMS — Enqueue and poll side of the planning queue.
 *
 * The controller talks only to this; it never touches the Bull queue directly. That keeps the
 * two rules that make these endpoints safe — deduplicate before adding, and refuse a job to
 * anyone but its requester — in one place rather than repeated at six route handlers, where the
 * seventh route would eventually forget one of them.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

import {
  PLANNING_JOB,
  PLANNING_JOB_OPTIONS,
  PLANNING_QUEUE,
  PlanningJobName,
  ScopeSnapshot,
  CoveragePlanJobData,
  DayPlansJobData,
  ProjectCandidatesJobData,
} from './planning-jobs.contract';
import {
  QueuedJobEnvelope,
  QueuedJobStatus,
  assertJobVisibleTo,
  dedupeKeyFor,
  describeJob,
  findInFlightDuplicate,
} from '../../infrastructure/queue/queued-job';

/** What a POST returns: the id to poll, and whether it joined a run already in flight. */
export interface EnqueueResult {
  jobId: string;
  /**
   * True when an identical request from the same account was already queued or running and this
   * call joined it instead of starting a second copy. Surfaced to the client because "your
   * request is already running" is a materially different thing to tell an operator who just
   * pressed the button twice than "a new run has started".
   */
  deduplicated: boolean;
}

@Injectable()
export class PlanningJobsService {
  private readonly logger = new Logger(PlanningJobsService.name);

  constructor(@InjectQueue(PLANNING_QUEUE) private readonly queue: Queue) {}

  async enqueueCoveragePlan(projectId: string, scope: ScopeSnapshot, requestedBy: string, startDate?: string | null): Promise<EnqueueResult> {
    // The start date is part of the fingerprint: a plan for another start day is another run.
    const params = { projectId, scope: scope ?? null, ...(startDate ? { startDate } : {}) };
    return this.add<CoveragePlanJobData>(PLANNING_JOB.COVERAGE_PLAN, {
      ...params,
      requestedBy,
      dedupeKey: dedupeKeyFor(PLANNING_JOB.COVERAGE_PLAN, requestedBy, params),
    });
  }

  async enqueueProjectCandidates(projectId: string, scope: ScopeSnapshot, requestedBy: string, startDate?: string | null): Promise<EnqueueResult> {
    const params = { projectId, scope: scope ?? null, ...(startDate ? { startDate } : {}) };
    return this.add<ProjectCandidatesJobData>(PLANNING_JOB.PROJECT_CANDIDATES, {
      ...params,
      requestedBy,
      dedupeKey: dedupeKeyFor(PLANNING_JOB.PROJECT_CANDIDATES, requestedBy, params),
    });
  }

  async enqueueDayPlans(
    projectIds: string[],
    targetDate: string | undefined,
    minDistanceKm: number | undefined,
    requestedBy: string,
  ): Promise<EnqueueResult> {
    // Sorted and de-duplicated so that "plan a day across A and B" and "…across B and A" are one
    // request rather than two identical runs. `generateDayPlans` already treats the list as a
    // set, so this changes the fingerprint and nothing else.
    const params = {
      projectIds: [...new Set(projectIds)].sort(),
      targetDate,
      minDistanceKm,
    };
    return this.add<DayPlansJobData>(PLANNING_JOB.DAY_PLANS, {
      ...params,
      requestedBy,
      dedupeKey: dedupeKeyFor(PLANNING_JOB.DAY_PLANS, requestedBy, params),
    });
  }

  /**
   * Poll one job.
   *
   * `userId` is not optional and is not a convenience: see `assertJobVisibleTo` for why an
   * unauthenticated or mismatched caller gets a 404 rather than a result.
   */
  async status(jobId: string, userId: string | undefined): Promise<QueuedJobStatus> {
    const job = assertJobVisibleTo(await this.queue.getJob(jobId), userId);
    // Planning polls carry the plan itself — the poll IS the delivery mechanism here, unlike the
    // report queue where the payload is a file fetched separately.
    return describeJob(job, { includeResult: true });
  }

  /**
   * Adds a job unless an identical one from the same account is still queued or running — the
   * shared rule (`findInFlightDuplicate`), the same one `BackgroundJobsService.enqueueTracked` applies
   * to the planning WRITE queue.
   *
   * These three are deliberately NOT tracked on a `background_jobs` row: each is a read the page
   * starts by itself (opening the coverage modal, switching to the day tab, toggling a project chip)
   * and awaits through the poll, so a row per run would fill the Jobs tray with noise. The candidates
   * report has no web caller at all.
   */
  private async add<T extends QueuedJobEnvelope>(name: PlanningJobName, data: T): Promise<EnqueueResult> {
    const inFlight = await findInFlightDuplicate(this.queue, name, data.dedupeKey, this.logger);
    if (inFlight) {
      this.logger.log(`Joining in-flight ${name} job ${inFlight.id} rather than starting a duplicate.`);
      return { jobId: String(inFlight.id), deduplicated: true };
    }
    const job = await this.queue.add(name, data, PLANNING_JOB_OPTIONS);
    this.logger.log(`Enqueued ${name} job ${job.id}.`);
    return { jobId: String(job.id), deduplicated: false };
  }
}
