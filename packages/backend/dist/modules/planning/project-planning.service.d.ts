import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService, AssayerRecommendation } from './planning.service';
export interface ProjectBranchCandidates {
    projectBranchId: string;
    branchId: string;
    branchCode: string;
    branchName: string;
    city: string;
    state: string;
    candidates: AssayerRecommendation[];
}
export interface ProjectPlanningReport {
    projectId: string;
    projectName: string;
    projectNumber: string;
    totalUnassignedBranches: number;
    branches: ProjectBranchCandidates[];
}
export declare class ProjectPlanningService {
    private readonly projectQueryService;
    private readonly planningService;
    constructor(projectQueryService: ProjectQueryService, planningService: PlanningService);
    getProjectPlanningCandidates(projectId: string): Promise<ProjectPlanningReport>;
}
