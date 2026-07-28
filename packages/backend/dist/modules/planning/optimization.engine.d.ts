import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService } from './planning.service';
export interface OptimizationMatching {
    projectBranchId: string;
    branchId: string;
    branchName: string;
    assignedAssayerId: string;
    assignedAssayerName: string;
    score: number;
}
export interface OptimizationPlan {
    projectId: string;
    projectName: string;
    totalBranchesMatched: number;
    totalBranchesUnmatched: number;
    assignments: OptimizationMatching[];
    unmatchedBranches: Array<{
        projectBranchId: string;
        branchId: string;
        branchName: string;
    }>;
}
export declare class OptimizationEngine {
    private readonly projectQueryService;
    private readonly planningService;
    constructor(projectQueryService: ProjectQueryService, planningService: PlanningService);
    generateProjectDeploymentPlan(projectId: string): Promise<OptimizationPlan>;
}
