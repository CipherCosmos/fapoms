/**
 * FAPOMS — Execute side of the planning queue.
 *
 * Each handler is the queued twin of a synchronous route that still exists and still works. They
 * call exactly the same service method with exactly the same arguments, so a queued run and a
 * synchronous run of the same request produce the same answer; the only thing that moved is
 * *where* the seconds are spent.
 */

import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';

import { CoveragePlanningEngine, CoveragePlanOutput } from './coverage-planning.engine';
import { ProjectPlanningService, ProjectPlanningReport } from './project-planning.service';
import { DayPlannerService, ProjectDayPlan } from './day-planner.service';
import {
  PLANNING_JOB,
  PLANNING_QUEUE,
  CoveragePlanJobData,
  DayPlansJobData,
  ProjectCandidatesJobData,
} from './planning-jobs.contract';
import { progressReporter } from './queued-job';

/**
 * Why every handler runs at concurrency 1.
 *
 * This processor runs inside the API process — there is no separate worker deployment — so the
 * CPU a coverage plan burns is CPU the request handlers are not getting, and the connections it
 * holds are connections out of the same pool. Concurrency 1 per job type is what turns "the
 * queue protects the API" from a slogan into a guarantee: however many plans are requested, at
 * most one is scoring branches at any moment, and the rest wait in Redis where waiting is free.
 *
 * Three named handlers at concurrency 1 means up to three heavy jobs in parallel, one of each
 * kind. That is deliberate: a long day-plan run should not block a coverage plan an operator is
 * waiting on, and three is a bound that stays comfortably inside the pool.
 */
const ONE_AT_A_TIME = 1;

@Processor(PLANNING_QUEUE)
export class PlanningJobsWorker {
  private readonly logger = new Logger(PlanningJobsWorker.name);

  constructor(
    private readonly coveragePlanningEngine: CoveragePlanningEngine,
    private readonly projectPlanningService: ProjectPlanningService,
    private readonly dayPlannerService: DayPlannerService,
  ) {}

  /**
   * Measured at 6.8 s for a 200-branch project on the 200k-assignment scale database.
   *
   * Note the handler name comes from the same constant the enqueue side uses. A `@Process()`
   * with no name would silently handle nothing here — that is the live defect on the
   * 'background-jobs' queue, and the reason this queue exists separately.
   */
  @Process({ name: PLANNING_JOB.COVERAGE_PLAN, concurrency: ONE_AT_A_TIME })
  async coveragePlan(job: Job<CoveragePlanJobData>): Promise<CoveragePlanOutput> {
    const { projectId, scope } = job.data;
    const onProgress = progressReporter(job);

    // Written before the first query. The engine loads the project, its branches and the whole
    // available assayer roster before it can count anything, and on a large project that is
    // seconds during which a bar left at 0% with no label reads as a stalled job.
    await onProgress(0, 1, 'Loading project and workforce');

    this.logger.log(`Coverage plan job ${job.id} starting for project ${projectId}.`);
    const plan = await this.coveragePlanningEngine.generateCoveragePlan(projectId, scope ?? undefined, onProgress);
    this.logger.log(
      `Coverage plan job ${job.id} finished: ${plan.coveragePercentage}% coverage over ${plan.clusters.length} cluster(s).`,
    );
    return plan;
  }

  /** Measured at 12.2 s for a 200-branch project — the slowest of the three. */
  @Process({ name: PLANNING_JOB.PROJECT_CANDIDATES, concurrency: ONE_AT_A_TIME })
  async projectCandidates(job: Job<ProjectCandidatesJobData>): Promise<ProjectPlanningReport> {
    const { projectId, scope } = job.data;
    const onProgress = progressReporter(job);
    await onProgress(0, 1, 'Loading project branches');

    this.logger.log(`Candidates job ${job.id} starting for project ${projectId}.`);
    const report = await this.projectPlanningService.getProjectPlanningCandidates(
      projectId,
      scope ?? undefined,
      onProgress,
    );
    this.logger.log(`Candidates job ${job.id} finished: ${report.branches.length} branch(es) ranked.`);
    return report;
  }

  @Process({ name: PLANNING_JOB.DAY_PLANS, concurrency: ONE_AT_A_TIME })
  async dayPlans(job: Job<DayPlansJobData>): Promise<ProjectDayPlan> {
    const { projectIds, targetDate, minDistanceKm } = job.data;
    const onProgress = progressReporter(job);
    await onProgress(0, 1, 'Clustering branches');

    this.logger.log(`Day plan job ${job.id} starting for ${projectIds.length} project(s).`);
    const plan = await this.dayPlannerService.generateDayPlans(projectIds, targetDate, minDistanceKm, onProgress);
    this.logger.log(`Day plan job ${job.id} finished: ${plan.clusters.length} cluster(s) planned.`);
    return plan;
  }
}
