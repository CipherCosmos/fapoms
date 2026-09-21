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
import { progressReporter } from '../../infrastructure/queue/queued-job';
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

  /** The deploy. Returns exactly the body the synchronous route used to answer with. */
  async executePlan(job: Job<ExecutePlanJobData>) {
    const { planId, scheduledDate, actor } = job.data;
    this.logger.log(`Deploy job ${job.id} starting for plan ${planId}.`);
    const result = await runAsJobActor(actor, () =>
      this.operationsPlanning.executeApprovedPlan(planId, actor.userId, scheduledDate, progressReporter(job)));
    this.logger.log(
      `Deploy job ${job.id} finished: ${result.deployed.length} deployed (${result.alreadyDeployedCount} by an earlier run), ${result.skipped.length} skipped.`,
    );
    return describeDeployment(result);
  }

  async generateVersion(job: Job<GenerateVersionJobData>) {
    const { projectId, overrides, justification, actor } = job.data;
    const onProgress = progressReporter(job);
    await onProgress(0, 1, 'Loading project and workforce');
    return runAsJobActor(actor, () =>
      this.operationsPlanning.createOrRegeneratePlan(
        projectId,
        (overrides ?? []) as unknown as PlanOverrideDto[],
        actor.userId,
        justification,
        onProgress,
      ));
  }

  /**
   * Offers each branch to one assayer, one assignment per branch, each on its own.
   *
   * The region ceiling is asserted per branch, as `POST /assignments` asserts it per call — the ids
   * arrive in a body, and a batch must not be a way around the check a single offer meets.
   */
  async bulkOffer(job: Job<BulkOfferJobData>): Promise<BulkBranchResult> {
    const { projectBranchIds, assayerId, assayerName, scheduledDate, acceptOnBehalf, acceptanceReason, scope, actor } = job.data;
    this.logger.log(`Bulk offer job ${job.id}: ${projectBranchIds.length} branch(es) to ${assayerId}.`);
    return runAsJobActor(actor, () =>
      this.eachBranch(job, projectBranchIds, 'Offering branches', async (projectBranchId): Promise<BulkBranchSucceeded> => {
        await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope ?? undefined);
        const created = await this.assignmentService.create({
          projectBranchId,
          assayerId,
          scheduledDate: scheduledDate || undefined,
          remarks: `Bulk-assigned to ${assayerName || 'the selected assayer'} from the planning queue`,
          acceptOnBehalf,
          acceptanceReason: acceptOnBehalf ? acceptanceReason : undefined,
        }, actor.userId);
        return { projectBranchId, assignmentId: created?.id, status: created?.status };
      }));
  }

  async bulkUnableToCover(job: Job<BulkUnableToCoverJobData>): Promise<BulkBranchResult> {
    const { projectBranchIds, reason, scope, actor } = job.data;
    this.logger.log(`Unable-to-cover job ${job.id}: ${projectBranchIds.length} branch(es).`);
    return runAsJobActor(actor, () =>
      this.eachBranch(job, projectBranchIds, 'Recording branches', async (projectBranchId): Promise<BulkBranchSucceeded> => {
        await this.regionGuard.assertProjectBranchInScope(projectBranchId, scope ?? undefined);
        await this.projectService.markBranchUnableToCover(projectBranchId, actor.userId, reason);
        return { projectBranchId };
      }));
  }

  /**
   * Runs `work` for each branch in turn, so one branch's refusal is that branch's outcome and not
   * the run's. Every id ends in exactly one of the two lists — nothing is dropped, which is the
   * failure the browser loop had when the rate limit refused some of its requests.
   */
  private async eachBranch(
    job: Job,
    ids: string[],
    stage: string,
    work: (projectBranchId: string) => Promise<BulkBranchSucceeded>,
  ): Promise<BulkBranchResult> {
    const onProgress = progressReporter(job);
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
