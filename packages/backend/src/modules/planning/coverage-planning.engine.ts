import { Inject, Injectable } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { ClusterManager, BranchCluster } from './cluster.manager';
import { PlanningBranchProvider, AssayerAvailabilityProvider, WorkloadProvider } from './planning-providers.interface';

export interface CoverageWarning {
  type: string;
  message: string;
}

export interface UncoveredBranchInfo {
  branchId: string;
  branchName: string;
  reason: string;
}

export interface AssayerCapacityMetrics {
  assayerId: string;
  displayName: string;
  weeklyCapacity: number;
  currentAllocation: number;
  remainingCapacity: number;
  utilizationPercentage: number;
}

export interface CoveragePlanOutput {
  projectId: string;
  projectName: string;
  coveragePercentage: number;
  estimatedDurationDays: number;
  estimatedOperationalCost: number;
  requiredWorkforceCount: number;
  availableWorkforceCount: number;
  confidenceScore: number;
  uncoveredBranches: UncoveredBranchInfo[];
  warnings: CoverageWarning[];
  workforceCapacity: AssayerCapacityMetrics[];
  clusters: Array<{ id: string; name: string; branchCount: number; assignedAssayerName: string | null }>;
}

@Injectable()
export class CoveragePlanningEngine {
  constructor(
    private readonly projectQueryService: ProjectQueryService,
    private readonly recommendationEngine: RecommendationEngine,
    private readonly constraintEvaluator: ConstraintEvaluator,
    private readonly clusterManager: ClusterManager,
    @Inject('PlanningBranchProvider')
    private readonly branchProvider: PlanningBranchProvider,
    @Inject('AssayerAvailabilityProvider')
    private readonly assayerProvider: AssayerAvailabilityProvider,
    @Inject('WorkloadProvider')
    private readonly workloadProvider: WorkloadProvider,
  ) {}

  async generateCoveragePlan(projectId: string): Promise<CoveragePlanOutput> {
    const project = await this.projectQueryService.findOne(projectId);
    const planningBranches = await this.branchProvider.getBranchesForPlanning(projectId);

    // Group branches into domain structures for clustering
    const activeBranches = planningBranches.map((pb) => {
      return {
        id: pb.branchId.value,
        name: pb.name,
        latitude: pb.location.latitude,
        longitude: pb.location.longitude,
      } as any;
    });

    const clusters = this.clusterManager.clusterBranches(activeBranches);

    const activeAssayers = await this.assayerProvider.getAvailableAssayers(new Date());
    const assayerIds = activeAssayers.map((a) => a.assayerId.value);
    const allocationMap = await this.workloadProvider.getAssayerCurrentWorkloads(assayerIds);

    const workforceCapacity: AssayerCapacityMetrics[] = activeAssayers.map((a) => {
      const weeklyCapacity = a.maxWeeklyWorkload || 15;
      const currentAllocation = allocationMap[a.assayerId.value] || 0;
      const remainingCapacity = Math.max(0, weeklyCapacity - currentAllocation);
      const utilizationPercentage = parseFloat(((currentAllocation / weeklyCapacity) * 100).toFixed(1));

      return {
        assayerId: a.assayerId.value,
        displayName: a.displayName,
        weeklyCapacity,
        currentAllocation,
        remainingCapacity,
        utilizationPercentage,
      };
    });

    const uncoveredBranches: UncoveredBranchInfo[] = [];
    const warnings: CoverageWarning[] = [];
    let matchedCount = 0;
    let totalEstimatedCost = 0;
    const assignedAssayerIds = new Set<string>();

    const clusterAssignments: Array<{ id: string; name: string; branchCount: number; assignedAssayerName: string | null }> = [];

    // Solve matching on clusters
    for (const cluster of clusters) {
      let assignedAssayerName: string | null = null;
      let highestScore = -1;
      let selectedAssayer: any | null = null;

      // Evaluate candidates on cluster center
      const dummyBranch = {
        id: cluster.id,
        latitude: cluster.centerLatitude,
        longitude: cluster.centerLongitude,
        clientId: project.clientId,
      } as any;

      const candidates = await this.recommendationEngine.recommend(dummyBranch, new Date());
      
      // Filter out double-booked or capacity-short candidates
      const validCandidates = candidates.filter((c) => {
        const remaining = (allocationMap[c.assayer.id] || 0) < (c.assayer.maxWeeklyWorkload || 15);
        return remaining;
      });

      if (validCandidates.length > 0) {
        selectedAssayer = validCandidates[0].assayer;
        highestScore = validCandidates[0].score;
        assignedAssayerName = selectedAssayer.displayName;
        assignedAssayerIds.add(selectedAssayer.id);

        // Consume workload and accumulate mock cost
        allocationMap[selectedAssayer.id] = (allocationMap[selectedAssayer.id] || 0) + cluster.branches.length;
        matchedCount += cluster.branches.length;
        totalEstimatedCost += cluster.branches.length * 1500; // Mock base fee cost calculation
      } else {
        // Explanations for uncovered clusters
        for (const b of cluster.branches) {
          uncoveredBranches.push({
            branchId: b.id,
            branchName: b.name,
            reason: 'No eligible workforce candidate with available capacity within territorial range.',
          });
        }
      }

      clusterAssignments.push({
        id: cluster.id,
        name: cluster.name,
        branchCount: cluster.branches.length,
        assignedAssayerName,
      });
    }

    const totalBranchesCount = activeBranches.length;
    const coveragePercentage = totalBranchesCount > 0 ? parseFloat(((matchedCount / totalBranchesCount) * 100).toFixed(1)) : 0;

    // Confidence model calculation
    let confidenceScore = 100;
    if (coveragePercentage < 80) confidenceScore -= 30;
    if (uncoveredBranches.length > 0) confidenceScore -= 10;
    if (activeAssayers.length === 0) confidenceScore -= 50;

    // Risk warning generation
    if (coveragePercentage < 90) {
      warnings.push({
        type: 'COVERAGE_GAP',
        message: `Project coverage is suboptimal (${coveragePercentage}%). Five or more branches cannot be matching automatically.`,
      });
    }

    // Resolve average workloads counts from the WorkloadProvider mapping values
    const currentAssignmentsCount = Object.values(allocationMap).reduce((acc, curr) => acc + curr, 0);
    const avgWorkloadRatio = activeAssayers.length > 0 ? currentAssignmentsCount / activeAssayers.length : 0;
    if (avgWorkloadRatio > 10) {
      warnings.push({
        type: 'CAPACITY_WARNING',
        message: 'High overall workforce load; tight margins could result in schedule delays.',
      });
      confidenceScore -= 15;
    }

    return {
      projectId,
      projectName: project.name,
      coveragePercentage,
      estimatedDurationDays: Math.ceil(totalBranchesCount / 4) || 1, // Mock formula
      estimatedOperationalCost: totalEstimatedCost,
      requiredWorkforceCount: assignedAssayerIds.size,
      availableWorkforceCount: activeAssayers.length,
      confidenceScore: Math.max(0, confidenceScore),
      uncoveredBranches,
      warnings,
      workforceCapacity,
      clusters: clusterAssignments,
    };
  }
}
