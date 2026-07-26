import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CoveragePlanEntity, CoveragePlanStatus } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { AssignmentService } from '../assignment/assignment.service';
import { ProjectQueryService } from '../project/project-query.service';

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

    // Apply manual overrides to the generated plan in memory
    for (const ov of overrides) {
      const cluster = calculatedData.clusters.find((c) => c.id.includes(ov.branchId) || c.id === ov.branchId);
      if (cluster) {
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

    plan.status = targetStatus;
    return this.planRepository.save(plan);
  }

  /**
   * Executes an approved plan, spawning standard operational assignments for scheduling.
   */
  async executeApprovedPlan(planId: string, userId: string): Promise<void> {
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

    // Spawn assignments from the approved plan allocations
    // Reuses standard AssignmentService logic to maintain compliance mapping
    const clusters = activeVersion.planData.clusters;
    for (const cluster of clusters) {
      if (!cluster.assignedAssayerName) continue;

      let assayerId = '';
      if (cluster.assignedAssayerName.startsWith('Override: ')) {
        assayerId = cluster.assignedAssayerName.replace('Override: ', '');
      } else {
        // Dynamically fetch the top candidate from recommendation engine instead of falling back to a hardcoded 'as-1' placeholder
        try {
          const dummyBranchForLookup = {
            id: cluster.id,
            latitude: cluster.centerLatitude,
            longitude: cluster.centerLongitude,
          } as any;
          const candidates = await this.planningEngine['recommendationEngine'].recommend(dummyBranchForLookup, new Date());
          if (candidates && candidates.length > 0) {
            assayerId = candidates[0].assayer.id;
          } else {
            assayerId = 'as-1'; // fallback standard assayer ID if no candidates exist
          }
        } catch {
          assayerId = 'as-1';
        }
      }

      // Map cluster back to project branch records
      const branchIds = cluster.branchCount > 0 ? [cluster.id.replace('cluster-', '')] : [];
      for (const branchId of branchIds) {
        const pb = projectBranches.find((p) => p.branchId === branchId);
        if (pb) {
          try {
            await this.assignmentService.create({
              projectBranchId: pb.id,
              assayerId,
              proposedFee: 1500,
              scheduledDate: new Date().toISOString().split('T')[0],
            }, userId);
          } catch (err) {
            console.error(`Automated planning generation skipped for branch ${pb.id}:`, err);
          }
        }
      }
    }

    plan.status = CoveragePlanStatus.DEPLOYED;
    await this.planRepository.save(plan);
  }
}
