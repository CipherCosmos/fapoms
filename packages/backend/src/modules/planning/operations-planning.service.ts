import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { PlanningService } from './planning.service';
import { EventCategory, businessTodayDateKey } from '@fapoms/shared';

export interface PlanOverrideDto {
  branchId: string;
  assayerId: string;
  lockAssayer?: boolean;
  pinAssignment?: boolean;
  justification: string;
}

/**
 * One assayer works one audit a day — the same rule `ConstraintEvaluator.checkDoubleBooking`
 * enforces at creation time. Spreading honours it up front so the deploy does not spend a
 * round trip discovering it per branch.
 */
const MAX_AUDITS_PER_ASSAYER_PER_DAY = 1;

/**
 * How many `suggestAuditDate` lookups run at once. A 155-branch plan doing these one at a time
 * is 155 sequential round trips (holiday + branch reads each); unbounded `Promise.all` instead
 * dumps 155 concurrent queries onto the pool. Bounded batching is the pattern the geo and
 * customer-master importers already use for the same shape of work.
 */
const DATE_LOOKUP_CONCURRENCY = 8;

/** How far ahead spreading is allowed to push a branch before it gives up and reports why. */
const MAX_SPREAD_DAYS = 365;

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
}

/** Local calendar date key — never `toISOString()`, which rolls an IST evening back a day. */
const dateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const parseKey = (key: string): Date => new Date(`${key.slice(0, 10)}T00:00:00`);

const addDays = (key: string, days: number): string => {
  const d = parseKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
};

@Injectable()
export class OperationsPlanningService {
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
  async createOrRegeneratePlan(projectId: string, overrides: PlanOverrideDto[] = [], userId?: string, justification?: string): Promise<CoveragePlanEntity> {
    let plan = await this.planRepository.findOne({
      where: { projectId },
      relations: ['versions'],
    });

    const calculatedData = await this.planningEngine.generateCoveragePlan(projectId);

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
  ): Promise<PlanDeploymentResult> {
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
      fee: number;
      earliestOffsetDays: number;
    }> = [];

    for (const cluster of clusters) {
      // Prefer the per-branch assignments the engine now records — each branch deploys to its OWN
      // recommended assayer at its own quoted fee. Older/parallel plans without per-branch data fall
      // back to the cluster-wide assayer + an even fee split (legacy behaviour).
      const perBranch: Array<{ branchId: string; assayerId: string | null; fee: number | null }> =
        Array.isArray(cluster.branchAssignments) && cluster.branchAssignments.length > 0
          ? cluster.branchAssignments.map((ba: any) => ({ branchId: ba.branchId, assayerId: ba.assayerId, fee: ba.fee }))
          : (() => {
              const branchIds: string[] = cluster.branchIds ?? [];
              const perBranchFee = cluster.estimatedTotalFee != null && branchIds.length > 0
                ? Math.round((Number(cluster.estimatedTotalFee) / branchIds.length) * 100) / 100
                : null;
              return branchIds.map((branchId) => ({ branchId, assayerId: cluster.assignedAssayerId ?? null, fee: perBranchFee }));
            })();

      // A cluster with an `estimatedDurationDays` estimate was planned as multi-day work; its
      // branches are spaced to occupy that many days rather than being crammed into the first
      // free ones, so the deployed calendar matches the plan the operator approved.
      const durationDays = Number(cluster.estimatedDurationDays) || 0;
      const stride = perBranch.length > 1 && durationDays > 1
        ? Math.max(1, Math.floor(durationDays / perBranch.length))
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
        if (item.fee == null) {
          skipped.push({ clusterId: cluster.id, branchId: item.branchId, reason: 'Plan carries no quoted fee for this branch.' });
          continue;
        }

        allocations.push({
          clusterId: cluster.id,
          branchId: item.branchId,
          projectBranchId: projectBranch.id,
          assayerId: item.assayerId,
          fee: item.fee,
          // The cluster's own share of the campaign window: branch #3 of a 6-day cluster does
          // not start on day one.
          earliestOffsetDays: position * stride,
        });
      }
    }

    // Per-branch workable dates, resolved ONCE per branch and in bounded batches.
    const branchDates = await this.resolveWorkableDates(allocations.map((a) => a.branchId));

    // Spread: walk allocations in plan order, giving each branch the first date that is
    // workable FOR THAT BRANCH (holidays/Sundays already excluded by suggestAuditDate) and on
    // which its assayer still has capacity. Purely in-memory — no extra queries per attempt.
    const loadByAssayerDate = new Map<string, number>();
    for (const alloc of allocations) {
      const branchDate = branchDates.get(alloc.branchId);
      // Never earlier than the operator's start date, and never earlier than the first date the
      // branch itself can be worked.
      const floor = branchDate && branchDate.earliest > startDate ? branchDate.earliest : startDate;
      let candidate = this.nextWorkableDate(addDays(floor, alloc.earliestOffsetDays), branchDate?.blocked);

      let placed: string | null = null;
      for (let hop = 0; hop < MAX_SPREAD_DAYS; hop++) {
        const loadKey = `${alloc.assayerId}|${candidate}`;
        if ((loadByAssayerDate.get(loadKey) ?? 0) < MAX_AUDITS_PER_ASSAYER_PER_DAY) {
          loadByAssayerDate.set(loadKey, (loadByAssayerDate.get(loadKey) ?? 0) + 1);
          placed = candidate;
          break;
        }
        candidate = this.nextWorkableDate(addDays(candidate, 1), branchDate?.blocked);
      }

      if (!placed) {
        skipped.push({
          clusterId: alloc.clusterId,
          branchId: alloc.branchId,
          reason: `No workable date within a year — the assigned assayer is already at capacity on every available day.`,
        });
        continue;
      }

      try {
        // Still an OFFER: `assignmentService.create` writes a PENDING proposal at the fee the
        // human approved. Nothing here grants an assayer's commitment or a rupee of it.
        const assignment = await this.assignmentService.create({
          projectBranchId: alloc.projectBranchId,
          assayerId: alloc.assayerId,
          proposedFee: alloc.fee,
          scheduledDate: placed,
        }, userId);
        deployed.push({ branchId: alloc.branchId, assignmentId: assignment.id, scheduledDate: placed });
      } catch (err) {
        skipped.push({ clusterId: alloc.clusterId, branchId: alloc.branchId, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    const skippedReasons = this.groupSkipReasons(skipped);
    const bookedDates = deployed.map((d) => d.scheduledDate).sort();
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
      return { deployed, skipped, skippedReasons, fullySkipped: true, dateRange: null };
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
    return { deployed, skipped, skippedReasons, fullySkipped: false, dateRange };
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
