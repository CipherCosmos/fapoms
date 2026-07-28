import { ProjectMetricsProvider } from './operations-providers.interface';
import { Repository } from 'typeorm';
import { ProjectEntity } from '../project/project.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
export declare class OperationsProjectMetricsAdapter implements ProjectMetricsProvider {
    private readonly projectRepository;
    private readonly projectBranchRepository;
    constructor(projectRepository: Repository<ProjectEntity>, projectBranchRepository: Repository<ProjectBranchEntity>);
    getTotalProjectsCount(): Promise<number>;
    getActiveProjectsCount(): Promise<number>;
    getProjectsAtRiskCount(breachedCounts: Record<string, number>): Promise<number>;
    getProjectBranchCounts(): Promise<{
        total: number;
        deployed: number;
    }>;
}
