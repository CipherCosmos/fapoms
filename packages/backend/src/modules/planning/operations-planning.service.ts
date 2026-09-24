import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { PlanningService } from './planning.service';
import { EventCategory, businessTodayDateKey, localDateKey } from '@fapoms/shared';
import type { ProgressCallback } from '../../infrastructure/queue/queued-job';

export interface PlanOverrideDto {
  branchId: string;
  assayerId: string;
  lockAssayer?: boolean;
  pinAssignment?: boolean;
  justification: string;
  /**
   * A fee the desk typed for this branch. The only fee a deploy sends to `create()`; without one
   * the job is priced there, by the same calculator and travel-once rule as every other offer.
   */
  deskFee?: number | null;
}

/**
 * The fee a deploy sends for one branch: the desk's typed number, or nothing.
 *
 * The coverage engine's per-branch `fee` is a planning ESTIMATE — `quote({ distanceKm: 0 })`, i.e.
 * the base fee with no travel at all ("per-branch travel resolved at assign time"). Deploy used to
 * send it as `proposedFee`, and `create()` records a supplied fee as the desk's number: so every
 * deployed offer was booked at base-only, the first job of each assayer's day never carried the
 * journey, and travel-once could not apply because there was no travel to charge once. Omitting it
 * lets `create()` price the job the normal way — the routed home→branch quote, base-only when the
 * assayer's day already carries travel.
 */
export function deployFeeFor(item: { deskFee?: number | null }): number | undefined {
  const typed = item.deskFee;
  return typed !== undefined && typed !== null && Number.isFinite(Number(typed)) ? Number(typed) : undefined;
}

/*
 * There is no per-assayer-per-day cap. There used to be one (`MAX_AUDITS_PER_ASSAYER_PER_DAY = 1`),
 * mirroring the one-job-per-day rule; owner decision 2026-09-24 (E2) is that one assayer may take
 * several branches on the same day with no limit, so a cluster planned as one day's work now
 * deploys onto one day. Travel on the second and later branches of that day is not charged again —
 * `AssignmentService.create` decides that (the first job of the day carries the journey).
 */

/**
 * How many `suggestAuditDate` lookups run at once. A 155-branch plan doing these one at a time
 * is 155 sequential round trips (holiday + branch reads each); unbounded `Promise.all` instead
 * dumps 155 concurrent queries onto the pool. Bounded batching is the pattern the geo and
 * customer-master importers already use for the same shape of work.
 */
const DATE_LOOKUP_CONCURRENCY = 8;

/** How far ahead spreading is allowed to push a branch before it gives up and reports why. */
const MAX_SPREAD_DAYS = 365;

/**
 * How many real `assignmentService.create` attempts one branch may burn retrying past a holiday
 * it collided with. Bounded separately from `MAX_SPREAD_DAYS` — each retry here is a real write attempt the server rejects,
 * and a plan spanning a genuinely unworkable stretch must not turn into hundreds of sequential
 * round trips for one branch. A fortnight of holiday collisions in a row does not happen; this
 * still leaves generous headroom over the worst realistic case (two adjacent state holidays).
 */
const MAX_CREATE_ATTEMPTS_PER_BRANCH = 10;

export interface PlanDeploymentResult {
  deployed: Array<{ branchId: string; assignmentId: string; scheduledDate: string }>;
  skipped: Array<{ clusterId: string; branchId: string | null; reason: string }>;
  /** Skip reasons collapsed to `reason → count`, so 155 identical failures read as one line. */
  skippedReasons: Array<{ reason: string; count: number }>;
  /**
   * True when the plan was approved but produced no assignments at all. This is an OUTCOME,
   * not an exception: on a fresh project with no fee data it is the likeliest first result,
   * and the desk needs the grouped reasons rendered — not a red error box with five of them.
   */
  fullySkipped: boolean;
  /** The first and last workable date actually booked, so the UI can say "spans 12 days". */
  dateRange: { start: string; end: string } | null;
  /**
   * How many of `deployed` an EARLIER run of this same plan version had already booked, and this
   * run therefore left alone. Zero on a first deploy. Non-zero when a run that died part-way is
   * deployed again, which is exactly the case that used to double every offer it had made.
   */
  alreadyDeployedCount: number;
}

/**
 * The key each branch's offer is written under when a plan version deploys.
 *
 * Deterministic in (plan, version, project branch) and nothing else — not the requester and not the
 * campaign start date — so any later run of the same version, by anyone, recognises a branch an
 * earlier run already booked. It travels to `AssignmentService.create` as `clientRequestId`, whose
 * durable record (`assignment_idempotency_records`, unique on this column, written in the same
 * transaction as the assignment) is what makes the answer survive a crash between two branches.
 *
 * `cplan:` + 36 + `:v` + version + `:` + 36 stays inside that column's 100 characters for any
 * version below 10^13.
 */
export const deploymentRequestId = (planId: string, version: number, projectBranchId: string): string =>
  `cplan:${planId}:v${version}:${projectBranchId}`;

/**
 * The deploy's response, shaped once.
 *
 * This was the synchronous route's body; it is now the job's result. Kept as one function so the
 * screen reads the same fields whichever way the deploy ran.
 */
export function describeDeployment(result: PlanDeploymentResult) {
  return {
    message: result.fullySkipped
      ? `Nothing could be deployed — ${result.skipped.length} allocation(s) were skipped.`
      : `Coverage plan deployed: ${result.deployed.length} assignment(s) created${result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : ''}` +
        (result.dateRange ? ` across ${result.dateRange.start} → ${result.dateRange.end}.` : '.'),
    deployedCount: result.deployed.length,
    skippedCount: result.skipped.length,
    deployed: result.deployed,
    skipped: result.skipped,
    // A fully-skipped deploy is an explained outcome rather than a thrown error, and each branch
    // carries its own workable date instead of one shared one.
    skippedReasons: result.skippedReasons,
    fullySkipped: result.fullySkipped,
    dateRange: result.dateRange,
    alreadyDeployedCount: result.alreadyDeployedCount,
  };
}

const parseKey = (key: string): Date => new Date(`${key.slice(0, 10)}T00:00:00`);

/**
 * Pure calendar arithmetic on a `YYYY-MM-DD` key. Parse and format both work in the same local
 * frame, so the answer is the calendar's regardless of the server's timezone; `localDateKey` is
 * the shared formatter (this file used to carry a byte-identical private copy).
 */
const addDays = (key: string, days: number): string => {
  const d = parseKey(key);
  d.setDate(d.getDate() + days);
  return localDateKey(d);
};

@Injectable()
export class OperationsPlanningService {
  private readonly logger = new Logger(OperationsPlanningService.name);

  constructor(
    @InjectRepository(CoveragePlanEntity)
    private readonly planRepository: Repository<CoveragePlanEntity>,
    @InjectRepository(CoveragePlanVersionEntity)
    private readonly versionRepository: Repository<CoveragePlanVersionEntity>,
    private readonly planningEngine: CoveragePlanningEngine,
    private readonly assignmentService: AssignmentService,
    private readonly projectQueryService: ProjectQueryService,
    private readonly auditService: AuditService,
    // Deployment reuses the very same date logic the single-branch planner seeds its picker
    // with (holidays, Sundays, non-working Saturdays), rather than inventing a second answer
    // to "when can this branch actually be audited?".
    private readonly planningService: PlanningService,
  ) {}

  /**
   * Initializes or regenerates a new plan version with optional manual overrides.
   */
  async createOrRegeneratePlan(
    projectId: string,
    overrides: PlanOverrideDto[] = [],
    userId?: string,
    justification?: string,
    /** The engine's branch-by-branch progress, for the job that runs this. Advisory only. */
    onProgress?: ProgressCallback,
  ): Promise<CoveragePlanEntity> {
    let plan = await this.planRepository.findOne({
      where: { projectId },
      relations: ['versions'],
    });

    const calculatedData = await this.planningEngine.generateCoveragePlan(projectId, undefined, onProgress);

    // Apply manual overrides to the generated plan in memory.
    //
    // This used to set only `assignedAssayerName` and match clusters by `c.id.includes(branchId)`
    // — so deployment (which reads `assignedAssayerId` and iterates `branchIds`) ignored the
    // override entirely and shipped the engine's original pick, while the saved plan version
    // *displayed* the operator's choice. Approved-vs-deployed divergence on the assayer who
    // actually gets sent. Match on the real branch list and set the id deployment reads.
    for (const ov of overrides) {
      const cluster = calculatedData.clusters.find(
        (c) => (c.branchIds ?? []).includes(ov.branchId) || c.id === ov.branchId,
      );
      if (cluster) {
        // Override the specific branch's per-branch assignment (what deploy now reads). Also update
        // the cluster-level display fields so the saved version reflects the operator's choice.
        const ba = cluster.branchAssignments?.find((b) => b.branchId === ov.branchId);
        if (ba) {
          ba.assayerId = ov.assayerId;
          ba.assayerName = `Override: ${ov.assayerId}`;
          // Only an explicit, typed number is carried as the desk's fee (see `deployFeeFor`).
          const typed = ov.deskFee;
          ba.deskFee = typed !== undefined && typed !== null && Number.isFinite(Number(typed)) ? Number(typed) : null;
        }
        cluster.assignedAssayerId = ov.assayerId;
        cluster.assignedAssayerName = `Override: ${ov.assayerId}`;
      }
    }

    if (!plan) {
      plan = this.planRepository.create({
        projectId,
        status: CoveragePlanStatus.GENERATED,
        currentVersion: 1,
      });
      plan = await this.planRepository.save(plan);
    } else {
      if (plan.status === CoveragePlanStatus.APPROVED || plan.status === CoveragePlanStatus.LOCKED) {
        throw new BadRequestException('Cannot regenerate or edit an approved or locked coverage plan.');
      }
      plan.currentVersion += 1;
      plan.status = CoveragePlanStatus.GENERATED;
      plan = await this.planRepository.save(plan);
    }

    const version = this.versionRepository.create({
      coveragePlanId: plan.id,
      versionNumber: plan.currentVersion,
      planData: calculatedData,
      overrides,
      createdBy: userId || 'system',
      changeJustification: justification || 'System auto-generation',
    });
    await this.versionRepository.save(version);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'COVERAGE_PLAN_VERSION_CREATED',
      entityType: 'COVERAGE_PLAN',
      entityId: plan.id,
      newState: CoveragePlanStatus.GENERATED,
      userId,
      remarks: `Generated version ${plan.currentVersion}${overrides.length > 0 ? ` with ${overrides.length} manual override(s)` : ''}. ${justification || 'System auto-generation'}`,
      metadata: {
        projectId,
        version: plan.currentVersion,
        overrides,
        justification: justification || 'System auto-generation',
        coveragePercentage: calculatedData.coveragePercentage,
      },
    });

    return this.planRepository.findOne({ where: { id: plan.id }, relations: ['versions'] }) as Promise<CoveragePlanEntity>;
  }

  /**
   * Transitions a coverage plan status. Enforces review & freeze paths.
   */
  async transitionPlanStatus(planId: string, targetStatus: CoveragePlanStatus, userId?: string): Promise<CoveragePlanEntity> {
    const plan = await this.planRepository.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException(`Coverage plan ${planId} not found.`);
    }

    // Rules validation on state transition paths
    if (targetStatus === CoveragePlanStatus.APPROVED && plan.status !== CoveragePlanStatus.GENERATED && plan.status !== CoveragePlanStatus.UNDER_REVIEW) {
      throw new BadRequestException('A coverage plan must be generated and reviewed before approval.');
    }

    const previousStatus = plan.status;
    plan.status = targetStatus;
    plan.updatedBy = userId ?? plan.updatedBy;
    const saved = await this.planRepository.save(plan);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'COVERAGE_PLAN_STATUS_CHANGED',
      entityType: 'COVERAGE_PLAN',
      entityId: saved.id,
      previousState: previousStatus,
      newState: targetStatus,
      userId,
      remarks: `Coverage plan moved ${previousStatus} → ${targetStatus}.`,
      metadata: { projectId: saved.projectId, version: saved.currentVersion },
    });

    return saved;
  }

  /**
   * Executes an approved plan, spawning standard operational assignments for scheduling.
   */
  async executeApprovedPlan(
    planId: string,
    userId: string,
    scheduledDateInput?: string,
    /** Branch-by-branch progress, for the job that runs this. Advisory; never fails the deploy. */
    onProgress?: ProgressCallback,
  ): Promise<PlanDeploymentResult> {
    await onProgress?.(0, 1, 'Loading the approved plan');
    const plan = await this.planRepository.findOne({ where: { id: planId }, relations: ['versions'] });
    if (!plan) {
      throw new NotFoundException(`Coverage plan ${planId} not found.`);
    }

    if (plan.status !== CoveragePlanStatus.APPROVED) {
      throw new BadRequestException('Execution denied: only APPROVED plans can be deployed.');
    }

    const activeVersion = plan.versions.find((v) => v.versionNumber === plan.currentVersion);
    if (!activeVersion) {
      throw new NotFoundException('Current plan version data not found.');
    }

    const projectBranches = await this.projectQueryService.findProjectBranches(plan.projectId);

    // Deploy exactly what was approved.
    //
    // This previously assigned a hardcoded `assayerId = 'as-1'` to `projectBranches[0]` for
    // every cluster at a flat 1500 fee, swallowing each resulting failure to the console. With
    // no assayer of that id, every create threw, nothing was ever assigned, and the plan was
    // still marked DEPLOYED — an approved plan that deployed nothing, reported as success.
    // The identifiers it needed weren't in the stored plan at all; the engine now records them.
    const clusters = activeVersion.planData.clusters || [];
    const branchById = new Map((projectBranches ?? []).map((pb: any) => [pb.branchId, pb]));
    // The caller's date is now the START of the campaign, not the date of every audit.
    //
    // This used to put EVERY branch on one `scheduledDate`. Deploying the 155-branch backlog
    // therefore booked 155 audits for a single day — which no coordinator can act on and no
    // assayer can work — so the whole-project path was unusable in practice and the desk fell
    // back to staffing branches one at a time (~620 clicks). Each branch now gets its own
    // workable date, spread forward from this start date.
    // Default to the business-timezone "today", not the UTC date (which is still yesterday for IST
    // before 05:30 and would schedule the audit a day early).
    const startDate = (scheduledDateInput || businessTodayDateKey()).slice(0, 10);

    const deployed: Array<{ branchId: string; assignmentId: string; scheduledDate: string }> = [];
    const skipped: Array<{ clusterId: string; branchId: string | null; reason: string }> = [];
    /** Everything deployable, collected before any date is chosen so dates can be batched. */
    const allocations: Array<{
      clusterId: string;
      branchId: string;
      projectBranchId: string;
      assayerId: string;
      /** The desk's typed fee, or undefined — `create()` then prices the job. */
      fee: number | undefined;
      earliestOffsetDays: number;
    }> = [];

    for (const cluster of clusters) {
      // Prefer the per-branch assignments the engine now records — each branch deploys to its OWN
      // recommended assayer. Older/parallel plans without per-branch data fall back to the
      // cluster-wide assayer (legacy behaviour). Each branch deploys with the desk's typed fee when the plan carries one, and with NO fee
      // otherwise — `create()` prices it (see `deployFeeFor`). The engine's own `fee`, and the legacy
      // even split of `estimatedTotalFee`, are estimates and are never sent.
      const perBranch: Array<{ branchId: string; assayerId: string | null; deskFee: number | null }> =
        Array.isArray(cluster.branchAssignments) && cluster.branchAssignments.length > 0
          ? cluster.branchAssignments.map((ba: any) => ({ branchId: ba.branchId, assayerId: ba.assayerId, deskFee: ba.deskFee ?? null }))
          : (cluster.branchIds ?? []).map((branchId: string) => ({ branchId, assayerId: cluster.assignedAssayerId ?? null, deskFee: null }));

      // How many of this cluster's branches go on each day. A cluster with an
      // `estimatedDurationDays` estimate was planned as that many days of work, so its branches
      // are shared out over exactly those days — several per day when there are more branches
      // than days (allowed since 2026-09-24). A cluster with no estimate keeps the old spacing of
      // one branch per day: nobody planned it as a single day, and a 30-branch cluster must not
      // land on one date by default.
      const durationDays = Number(cluster.estimatedDurationDays) || 0;
      const branchesPerDay = durationDays >= 1 && perBranch.length > 0
        ? Math.max(1, Math.ceil(perBranch.length / durationDays))
        : 1;

      let indexInCluster = 0;
      for (const item of perBranch) {
        const position = indexInCluster++;
        if (!item.assayerId) {
          skipped.push({ clusterId: cluster.id, branchId: item.branchId, reason: 'Plan left this branch uncovered — no assayer was matched at approval time.' });
          continue;
        }
        const projectBranch = branchById.get(item.branchId);
        if (!projectBranch) {
          skipped.push({ clusterId: cluster.id, branchId: item.branchId, reason: 'Branch is no longer part of this project.' });
          continue;
        }
        allocations.push({
          clusterId: cluster.id,
          branchId: item.branchId,
          projectBranchId: projectBranch.id,
          assayerId: item.assayerId,
          fee: deployFeeFor(item),
          // The cluster's own share of the campaign window: branch #3 of a 6-branch, 3-day
          // cluster starts on day two, alongside branch #4.
          earliestOffsetDays: Math.floor(position / branchesPerDay),
        });
      }
    }

    // Per-branch workable dates, resolved ONCE per branch and in bounded batches.
    await onProgress?.(0, 1, 'Finding workable dates');
    const branchDates = await this.resolveWorkableDates(allocations.map((a) => a.branchId));

    /**
     * Branches an earlier run of THIS plan version already booked.
     *
     * A deploy that died part-way — a restart, an out-of-memory kill, the old request that the
     * browser abandoned at 30 s while the server carried on — left the plan APPROVED with some of
     * its offers made. Deploying it again walked every branch from the top, and `create` on a branch
     * with a PENDING offer used to reassign that offer, with a fresh event and a fresh
     * notification to the assayer (it now refuses with BRANCH_HAS_LIVE_OFFER). Those branches are
     * left exactly as the earlier run left them and reported as deployed.
     */
    const requestIdOf = (alloc: { projectBranchId: string }) =>
      deploymentRequestId(plan.id, plan.currentVersion, alloc.projectBranchId);
    const earlierRuns = await this.findEarlierDeployments(allocations.map(requestIdOf));
    let alreadyDeployedCount = 0;

    // Spread: walk allocations in plan order, giving each branch the first date on or after its
    // offset that is workable FOR THAT BRANCH. (No per-assayer day capacity any more — see the
    // note at the top of this file.)
    //
    // `branchDate.blocked` is NOT a complete holiday calendar — it is only the handful of dates
    // `suggestAuditDate` happened to step over on its own one-time search for the branch's
    // EARLIEST workable date, resolved once, up front (see `resolveWorkableDates`). A candidate
    // this loop pushes past that narrow window — by the campaign's own per-branch offset — can
    // land on a real
    // holiday or non-working Saturday `blocked` never recorded. `nextWorkableDate` on its own
    // only catches a plain Sunday.
    //
    // Found live: a 3-branch same-assayer cluster starting 2026-09-10 placed branch 1 on
    // 2026-09-11 after a cross-cluster capacity collision, which pushed branch 2 to
    // 2026-09-12 (a non-working Saturday `blocked` had no entry for) and branch 3 all the way to
    // 2026-09-14 (a real state holiday, same reason) — both rejected by `assignmentService.create`
    // and simply abandoned, even though 2026-09-15 was perfectly workable and never tried.
    //
    // `assignmentService.create` is the one place that always knows (see `resolveWorkableDates`'
    // own comment) — a "Holiday Conflict:" rejection from it now advances the candidate and
    // retries instead of giving up on the branch.
    // Any OTHER rejection (fee ceiling, eligibility, ...) is not a date problem and advancing the
    // date cannot fix it, so it still fails the branch immediately, unchanged from before.

    let allocationIndex = 0;
    for (const alloc of allocations) {
      await onProgress?.(allocationIndex++, allocations.length, 'Creating offers');
      const requestId = requestIdOf(alloc);
      const earlier = earlierRuns.get(requestId);
      if (earlier) {
        deployed.push({ branchId: alloc.branchId, assignmentId: earlier.assignmentId, scheduledDate: earlier.scheduledDate ?? '' });
        alreadyDeployedCount++;
        continue;
      }

      const branchDate = branchDates.get(alloc.branchId);
      // Never earlier than the operator's start date, and never earlier than the first date the
      // branch itself can be worked.
      const floor = branchDate && branchDate.earliest > startDate ? branchDate.earliest : startDate;
      let candidate = this.nextWorkableDate(addDays(floor, alloc.earliestOffsetDays), branchDate?.blocked);

      let placed: string | null = null;
      let lastRejection: string | null = null;
      let createAttempts = 0;
      for (let hop = 0; hop < MAX_SPREAD_DAYS; hop++) {
        if (createAttempts >= MAX_CREATE_ATTEMPTS_PER_BRANCH) break;
        createAttempts++;
        try {
          // Still an OFFER: `assignmentService.create` writes a PENDING proposal, priced by the
          // normal create pricing (quote + travel once a day) unless the desk typed a fee for this
          // branch. Nothing here grants an assayer's commitment or a rupee of it.
          const assignment = await this.assignmentService.create({
            projectBranchId: alloc.projectBranchId,
            assayerId: alloc.assayerId,
            ...(alloc.fee !== undefined ? { proposedFee: alloc.fee } : {}),
            scheduledDate: candidate,
            // The durable per-branch guard — see `deploymentRequestId`. The lookup above spares a
            // re-run the work; this is what still holds if two runs reach one branch at once.
            clientRequestId: requestId,
          }, userId);
          placed = candidate;
          deployed.push({ branchId: alloc.branchId, assignmentId: assignment.id, scheduledDate: placed });
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          lastRejection = message;
          if (message.startsWith('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST')) {
            // Another run of this plan version booked this branch between our lookup and our
            // write (a second worker replica). It is deployed — by that run — not refused.
            const concurrent = (await this.findEarlierDeployments([requestId])).get(requestId);
            if (concurrent) {
              placed = concurrent.scheduledDate ?? candidate;
              deployed.push({ branchId: alloc.branchId, assignmentId: concurrent.assignmentId, scheduledDate: placed });
              alreadyDeployedCount++;
            }
            break;
          }
          if (!message.startsWith('Holiday Conflict:')) break;
          candidate = this.nextWorkableDate(addDays(candidate, 1), branchDate?.blocked);
        }
      }

      if (!placed) {
        skipped.push({
          clusterId: alloc.clusterId,
          branchId: alloc.branchId,
          reason: lastRejection ?? `No workable date within a year for this branch.`,
        });
      }
    }

    const skippedReasons = this.groupSkipReasons(skipped);
    const bookedDates = deployed.map((d) => d.scheduledDate).filter(Boolean).sort();
    const dateRange = bookedDates.length > 0
      ? { start: bookedDates[0], end: bookedDates[bookedDates.length - 1] }
      : null;

    // A plan that produced no assignments has not been deployed, and must not be recorded as
    // though it had — that status is what downstream reporting and the client see. But it is
    // also not a CRASH: throwing surfaced only the first five reasons in a red error box, which
    // is exactly the first experience of a fresh project with no fee data. Return the same
    // structured result as a successful deploy, with `fullySkipped` set and reasons grouped, so
    // the modal can explain "nothing could be deployed — 155 branches had no assayer in range".
    if (deployed.length === 0) {
      await this.auditService.recordEventSafe({
        category: EventCategory.WORKFLOW,
        eventType: 'COVERAGE_PLAN_DEPLOYMENT_FAILED',
        entityType: 'COVERAGE_PLAN',
        entityId: plan.id,
        previousState: plan.status,
        newState: plan.status,
        userId,
        remarks: `Deployment produced no assignments across ${clusters.length} cluster(s). ` +
          skippedReasons.map((r) => `${r.count}× ${r.reason}`).join('; '),
        metadata: { projectId: plan.projectId, version: plan.currentVersion, skipped, skippedReasons },
      });
      // Status deliberately left APPROVED — the plan can be fixed and deployed again.
      return { deployed, skipped, skippedReasons, fullySkipped: true, dateRange: null, alreadyDeployedCount };
    }

    const previousStatus = plan.status;
    plan.status = CoveragePlanStatus.DEPLOYED;
    plan.updatedBy = userId ?? plan.updatedBy;
    await this.planRepository.save(plan);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'COVERAGE_PLAN_DEPLOYED',
      entityType: 'COVERAGE_PLAN',
      entityId: plan.id,
      previousState: previousStatus,
      newState: CoveragePlanStatus.DEPLOYED,
      userId,
      remarks: `Deployed version ${plan.currentVersion}: ${deployed.length} assignment(s) created${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}` +
        (dateRange ? ` across ${dateRange.start} → ${dateRange.end}.` : '.'),
      metadata: { projectId: plan.projectId, version: plan.currentVersion, deployed, skipped, skippedReasons, dateRange },
    });

    // Surfaced to the caller so ops sees exactly how many branches deployed vs were skipped and
    // why — instead of a bare "success" that hides a plan where half the branches failed to staff.
    return { deployed, skipped, skippedReasons, fullySkipped: false, dateRange, alreadyDeployedCount };
  }

  /**
   * The first workable date for each branch, plus the dates that branch's calendar rules ruled
   * out — resolved in bounded batches.
   *
   * `PlanningService.suggestAuditDate` is the single implementation of "when can this branch
   * actually be audited?" (Sundays, state public holidays, client working days, via
   * ConstraintEvaluator). Deployment reuses it rather than growing a second copy that could
   * disagree with the date the single-branch planner seeds. Running 155 of them sequentially
   * would make the bulk path slow enough to feel broken, so they go out
   * DATE_LOOKUP_CONCURRENCY at a time.
   *
   * A branch whose lookup fails is not skipped — it simply falls back to the plain
   * weekday-spreading path and lets `assignmentService.create` apply the same rules per branch.
   */
  private async resolveWorkableDates(
    branchIds: string[],
  ): Promise<Map<string, { earliest: string; blocked: Set<string> }>> {
    const unique = Array.from(new Set(branchIds));
    const resolved = new Map<string, { earliest: string; blocked: Set<string> }>();

    for (let i = 0; i < unique.length; i += DATE_LOOKUP_CONCURRENCY) {
      const batch = unique.slice(i, i + DATE_LOOKUP_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (branchId) => {
          try {
            const suggestion = await this.planningService.suggestAuditDate(branchId);
            return { branchId, suggestion };
          } catch {
            return { branchId, suggestion: null };
          }
        }),
      );
      for (const { branchId, suggestion } of results) {
        if (!suggestion) continue;
        resolved.set(branchId, {
          earliest: suggestion.date.slice(0, 10),
          // The dates suggestAuditDate walked past (Sunday, holiday, non-working Saturday) are
          // exactly the dates spreading must not land a pushed-back branch on.
          blocked: new Set((suggestion.skipped ?? []).map((s) => s.date.slice(0, 10))),
        });
      }
    }

    return resolved;
  }

  /**
   * The offers earlier runs wrote under these deployment keys, with where they landed.
   *
   * Read straight from the idempotency table `AssignmentService.create` writes in the same
   * transaction as the assignment — the one record that says "this key produced that assignment"
   * and cannot disagree with it. Joined to the assignment for the assayer and date, so capacity
   * spreading sees the day as taken.
   *
   * A failed lookup is logged-and-empty rather than fatal: every create still carries its key, so
   * `create`'s own durable check refuses a second booking even when this read could not tell us.
   * What is lost is only the tidy "already deployed" count for that run.
   */
  private async findEarlierDeployments(
    requestIds: string[],
  ): Promise<Map<string, { assignmentId: string; assayerId: string | null; scheduledDate: string | null }>> {
    const found = new Map<string, { assignmentId: string; assayerId: string | null; scheduledDate: string | null }>();
    if (requestIds.length === 0) return found;
    try {
      const rows: Array<{ client_request_id: string; assignment_id: string; assayer_id: string | null; scheduled_date: string | null }> =
        await this.planRepository.manager.query(
          `SELECT r.client_request_id, r.assignment_id, a.assayer_id,
                  to_char(a.scheduled_date, 'YYYY-MM-DD') AS scheduled_date
             FROM assignment_idempotency_records r
             JOIN assignments a ON a.id = r.assignment_id
            WHERE r.client_request_id = ANY($1::varchar[])`,
          [requestIds],
        );
      for (const row of rows ?? []) {
        found.set(row.client_request_id, {
          assignmentId: row.assignment_id,
          assayerId: row.assayer_id,
          scheduledDate: row.scheduled_date,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Could not read earlier deployments (${(err as Error).message}); relying on create's own idempotency check.`,
      );
    }
    return found;
  }

  /** First date on/after `from` that is neither a Sunday nor known-blocked for the branch. */
  private nextWorkableDate(from: string, blocked?: Set<string>): string {
    let candidate = from;
    for (let hop = 0; hop < MAX_SPREAD_DAYS; hop++) {
      const isSunday = parseKey(candidate).getDay() === 0;
      if (!isSunday && !(blocked?.has(candidate) ?? false)) return candidate;
      candidate = addDays(candidate, 1);
    }
    return from;
  }

  /**
   * 155 branches skipped for the same reason is one fact, not 155. Grouped counts are what let
   * the modal say "155 branches had no assayer within range" instead of listing five of them.
   */
  private groupSkipReasons(
    skipped: Array<{ reason: string }>,
  ): Array<{ reason: string; count: number }> {
    const counts = new Map<string, number>();
    for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
  }
}
