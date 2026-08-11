import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, businessTodayDateKey } from '@fapoms/shared';

export interface PlanOverrideDto {
  branchId: string;
  assayerId: string;
  lockAssayer?: boolean;
  pinAssignment?: boolean;
  justification: string;
}

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
  ): Promise<{ deployed: Array<{ branchId: string; assignmentId: string }>; skipped: Array<{ clusterId: string; branchId: string | null; reason: string }> }> {
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
    // Defaults to today only when the caller states no date; a plan approved on a Friday for
    // next week should not silently deploy against Friday.
    // Default to the business-timezone "today", not the UTC date (which is still yesterday for IST
    // before 05:30 and would schedule the audit a day early).
    const scheduledDate = scheduledDateInput || businessTodayDateKey();

    const deployed: Array<{ branchId: string; assignmentId: string }> = [];
    const skipped: Array<{ clusterId: string; branchId: string | null; reason: string }> = [];

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

      for (const item of perBranch) {
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

        try {
          const assignment = await this.assignmentService.create({
            projectBranchId: projectBranch.id,
            assayerId: item.assayerId,
            proposedFee: item.fee,
            scheduledDate,
          }, userId);
          deployed.push({ branchId: item.branchId, assignmentId: assignment.id });
        } catch (err) {
          skipped.push({ clusterId: cluster.id, branchId: item.branchId, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // A plan that produced no assignments has not been deployed, and must not be recorded as
    // though it had — that status is what downstream reporting and the client see.
    if (deployed.length === 0) {
      await this.auditService.recordEventSafe({
        category: EventCategory.WORKFLOW,
        eventType: 'COVERAGE_PLAN_DEPLOYMENT_FAILED',
        entityType: 'COVERAGE_PLAN',
        entityId: plan.id,
        previousState: plan.status,
        newState: plan.status,
        userId,
        remarks: `Deployment produced no assignments across ${clusters.length} cluster(s).`,
        metadata: { projectId: plan.projectId, version: plan.currentVersion, skipped },
      });
      throw new BadRequestException(
        `Deployment created no assignments. ${skipped.length} allocation(s) could not be deployed: ` +
          skipped.slice(0, 5).map((s2) => `${s2.branchId ?? s2.clusterId} — ${s2.reason}`).join('; '),
      );
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
      remarks: `Deployed version ${plan.currentVersion}: ${deployed.length} assignment(s) created${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}.`,
      metadata: { projectId: plan.projectId, version: plan.currentVersion, deployed, skipped },
    });

    // Surfaced to the caller so ops sees exactly how many branches deployed vs were skipped and
    // why — instead of a bare "success" that hides a plan where half the branches failed to staff.
    return { deployed, skipped };
  }
}
