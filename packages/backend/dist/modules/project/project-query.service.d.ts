import { Repository } from 'typeorm';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
export declare class ProjectQueryService {
    private readonly projectRepository;
    private readonly projectBranchRepository;
    constructor(projectRepository: Repository<ProjectEntity>, projectBranchRepository: Repository<ProjectBranchEntity>);
    findOne(id: string): Promise<ProjectEntity>;
    findAll(page?: number, limit?: number): Promise<{
        projects: ProjectEntity[];
        total: number;
    }>;
    findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]>;
    findProjectBranchById(id: string): Promise<ProjectBranchEntity | null>;
}
