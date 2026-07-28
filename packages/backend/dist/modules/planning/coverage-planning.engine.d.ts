import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { ClusterManager } from './cluster.manager';
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
    clusters: Array<{
        id: string;
        name: string;
        branchCount: number;
        assignedAssayerName: string | null;
    }>;
}
export declare class CoveragePlanningEngine {
    private readonly projectQueryService;
    private readonly recommendationEngine;
    private readonly constraintEvaluator;
    private readonly clusterManager;
    private readonly branchProvider;
    private readonly assayerProvider;
    private readonly workloadProvider;
    constructor(projectQueryService: ProjectQueryService, recommendationEngine: RecommendationEngine, constraintEvaluator: ConstraintEvaluator, clusterManager: ClusterManager, branchProvider: PlanningBranchProvider, assayerProvider: AssayerAvailabilityProvider, workloadProvider: WorkloadProvider);
    generateCoveragePlan(projectId: string): Promise<CoveragePlanOutput>;
}
