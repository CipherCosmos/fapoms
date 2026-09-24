/**
 * FAPOMS — Execute side of the planning WRITE queue.
 *
 * Each case calls the same service method its synchronous route called, with the same arguments,
 * inside the scope of the person who pressed the button. What moved is where the minutes are spent
 * and who waits for them: the worker, not a browser that gives up at 30 seconds.
 */

import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';

import { OperationsPlanningService, describeDeployment } from './operations-planning.service';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectService } from '../project/project.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { runAsJobActor } from '../../infrastructure/queue/job-actor';
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';
import {
  BulkBranchResult,
  BulkBranchSucceeded,
  BulkOfferJobData,
  BulkUnableToCoverJobData,
  ExecutePlanJobData,
  GenerateVersionJobData,
  PLANNING_WRITE_JOB,
  PLANNING_WRITE_QUEUE,
} from './planning-write-jobs.contract';
import type { PlanOverrideDto } from './operations-planning.service';

type AnyWriteJob = Job<ExecutePlanJobData | GenerateVersionJobData | BulkOfferJobData | BulkUnableToCoverJobData>;

/**
 * The refusal in the words the synchronous route would have answered with.
 *
 * Nest's exceptions keep their operator-facing message on `getResponse().message` — an array for a
 * validation failure — and `Error.message` for everything else. A bulk run that reported "Failed"
 * for every branch would be the same silence the browser loop had.
 */
export function refusalOf(err: unknown): string {
  const response = (err as { getResponse?: () => unknown })?.getResponse?.();
  const message = response && typeof response === 'object' ? (response as { message?: unknown }).message : undefined;
  if (Array.isArray(message) && message.length > 0) return message.join('; ');
  if (typeof message === 'string' && message) return message;
  return err instanceof Error && err.message ? err.message : 'Failed without a reason.';
}

/** The tracked row's one line for a bulk run: "35 of 37 branches offered to Ravi; 2 refused." */
export function describeBulk(result: BulkBranchResult, done: string, countKey: string) {
  const ok = result.succeeded.length;
  const total = ok + result.failed.length;
  const branches = total === 1 ? 'branch' : 'branches';
  return {
    summary: result.failed.length === 0
      ? `${ok} ${branches} ${done}.`
      : `${ok} of ${total} ${branches} ${done}; ${result.failed.length} refused.`,
    counts: { [countKey]: ok, refused: result.failed.length },
  };
}

/**
 * ONE loop for the whole queue, dispatching on the job name — not a `@Process` per job.
 *
 * Bull does not reserve a lane per job name: each `@Process({ name, concurrency })` adds loops to
 * the queue and every loop takes the next job of any name. Four named handlers would have been four
 * loops, so two deploys, or a deploy and a bulk offer to the same assayer, could interleave their
 * writes. One `'*'` loop makes "one planning write at a time" true on each worker process. (Across
 * worker replicas it is not, which is why the deploy also carries a per-branch idempotency key.)
 */
@Processor(PLANNING_WRITE_QUEUE)
export class PlanningWriteJobsWorker {
  private readonly logger = new Logger(PlanningWriteJobsWorker.name);

  constructor(
    private readonly operationsPlanning: OperationsPlanningService,
    private readonly assignmentService: AssignmentService,
    private readonly projectService: ProjectService,
    private readonly regionGuard: RegionGuardService,
    private readonly tracker: BackgroundJobTracker,
  ) {}

  @Process({ name: '*', concurrency: 1 })
  async run(job: AnyWriteJob) {
    switch (job.name) {
      case PLANNING_WRITE_JOB.EXECUTE_PLAN:
        return this.executePlan(job as Job<ExecutePlanJobData>);
      case PLANNING_WRITE_JOB.GENERATE_VERSION:
        return this.generateVersion(job as Job<GenerateVersionJobData>);
      case PLANNING_WRITE_JOB.BULK_OFFER:
        return this.bulkOffer(job as Job<BulkOfferJobData>);
      case PLANNING_WRITE_JOB.BULK_UNABLE_TO_COVER:
        return this.bulkUnableToCover(job as Job<BulkUnableToCoverJobData>);
      default:
        // A name nothing here knows would otherwise complete silently with no result.
        throw new Error(`No handler for planning write job "${job.name}".`);
    }
  }

  /**
   * The deploy. Returns exactly the body the synchronous route used to answer with.
   *
   * Every handler runs through the tracker: the row that lets a refreshed page find this run goes
   * RUNNING → SUCCEEDED/FAILED with a one-line summary, while the Bull return value — what the poll
   * route hands the page — and the rethrow on failure are unchanged.
   */
  async executePlan(job: Job<ExecutePlanJobData>) {
    const { planId, scheduledDate, actor } = job.data;
    this.logger.log(`Deploy job ${job.id} starting for plan ${planId}.`);
    return this.tracker.run(job, async (t) => {
      const result = await runAsJobActor(actor, () =>
        this.operationsPlanning.executeApprovedPlan(planId, actor.userId, scheduledDate, t.progress));
      this.logger.log(
        `Deploy job ${job.id} finished: ${result.deployed.length} deployed (${result.alreadyDeployedCount} by an earlier run), ${result.skipped.length} skipped.`,
      );
      return describeDeployment(result);
    }, {
      describe: (r) => ({
        summary: r.message,
        counts: { deployed: r.deployedCount, skipped: r.skippedCount, alreadyDeployed: r.alreadyDeployedCount },
      }),
    });
  }

  async generateVersion(job: Job<GenerateVersionJobData>) {
    const { projectId, overrides, justification, actor, scope, startDate } = job.data;
    return this.tracker.run(job, async (t) => {
      await t.progress(0, 1, 'Loading project and workforce');
      return runAsJobActor(actor, () =>
        this.operationsPlanning.createOrRegeneratePlan(
          projectId,
          (overrides ?? []) as unknown as PlanOverrideDto[],
          actor.userId,
          justification,
          t.progress,
          { scope: scope ?? undefined, startDate: startDate ?? null },
        ));
    }, {
      describe: (plan) => ({
        summary: `Coverage plan version ${plan.currentVersion} generated (${String(plan.status).toLowerCase()}).`,
        counts: { version: plan.currentVersion },
      }),
    });
  }

  /**
   * Offers each branch to one assayer, one assignment per branch, each on its own.
   *
   * The region ceiling is asserted per branch, as `POST /assignments` asserts it per call — the ids
   * arrive in a body, and a batch must not be a way around the check a single offer meets.
   */
  async bulkOffer(job: Job<BulkOfferJobData>): Promise<BulkBranchResult> {
    const { projectBranchIds, assayerId, assayerName, scheduledDate, acceptOnBehalf, acceptanceReason, overrideReason, scope, actor } = job.data;
    this.logger.log(`Bulk offer job ${job.id}: ${projectBranchIds.length} branch(es) to ${assayerId}.`);
    return this.tracker.run(job, (t) => runAsJobActor(actor, () =>
      this.eachBranch(t.progress, projectBranchIds, 'Offering branches', async (projectBranchId): Promise<BulkBranchSucceeded> => {
        await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope ?? undefined);
        const created = await this.assignmentService.create({
          projectBranchId,
          assayerId,
          scheduledDate: scheduledDate || undefined,
          remarks: `Bulk-assigned to ${assayerName || 'the selected assayer'} from the planning queue`,
          acceptOnBehalf,
          acceptanceReason: acceptOnBehalf ? acceptanceReason : undefined,
          // Waives an overridable rule (e.g. rotation) on this branch; recorded by create().
          ...(overrideReason ? { overrideReason } : {}),
        }, actor.userId);
        return { projectBranchId, assignmentId: created?.id, status: created?.status };
      })), { describe: (r) => describeBulk(r, `offered to ${assayerName || 'the assayer'}`, 'offered') });
  }

  async bulkUnableToCover(job: Job<BulkUnableToCoverJobData>): Promise<BulkBranchResult> {
    const { projectBranchIds, reason, scope, actor } = job.data;
    this.logger.log(`Unable-to-cover job ${job.id}: ${projectBranchIds.length} branch(es).`);
    return this.tracker.run(job, (t) => runAsJobActor(actor, () =>
      this.eachBranch(t.progress, projectBranchIds, 'Recording branches', async (projectBranchId): Promise<BulkBranchSucceeded> => {
        await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope ?? undefined);
        await this.projectService.markBranchUnableToCover(projectBranchId, actor.userId, reason);
        return { projectBranchId };
      })), { describe: (r) => describeBulk(r, 'marked unable to cover', 'recorded') });
  }

  /**
   * Runs `work` for each branch in turn, so one branch's refusal is that branch's outcome and not
   * the run's. Every id ends in exactly one of the two lists — nothing is dropped, which is the
   * failure the browser loop had when the rate limit refused some of its requests.
   */
  private async eachBranch(
    onProgress: ProgressCallback,
    ids: string[],
    stage: string,
    work: (projectBranchId: string) => Promise<BulkBranchSucceeded>,
  ): Promise<BulkBranchResult> {
    const result: BulkBranchResult = { succeeded: [], failed: [] };
    for (let i = 0; i < ids.length; i++) {
      await onProgress(i, ids.length, stage);
      try {
        result.succeeded.push(await work(ids[i]));
      } catch (err) {
        result.failed.push({ projectBranchId: ids[i], error: refusalOf(err) });
      }
    }
    return result;
  }
}
