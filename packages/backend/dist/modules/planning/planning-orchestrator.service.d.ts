import { Repository } from 'typeorm';
import { ProjectBranchEntity } from '../project/project-branch.entity';
export declare class PlanningOrchestratorService {
    private readonly projectBranchRepository;
    constructor(projectBranchRepository: Repository<ProjectBranchEntity>);
    getProjectCoverage(projectId: string): Promise<{
        total: number;
        scheduled: number;
        confirmed: number;
        remaining: number;
        coveragePercentage: number;
    }>;
}
