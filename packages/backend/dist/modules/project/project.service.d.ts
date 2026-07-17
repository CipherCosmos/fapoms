import { Repository } from 'typeorm';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
export interface CreateProjectDto {
    name: string;
    projectNumber: string;
    description?: string;
    clientId: string;
    priority: string;
    startDate?: string;
    endDate?: string;
}
export declare class ProjectService {
    private readonly projectRepository;
    private readonly projectBranchRepository;
    private readonly auditService;
    constructor(projectRepository: Repository<ProjectEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, auditService: AuditService);
    create(dto: CreateProjectDto, userId: string): Promise<ProjectEntity>;
    findAll(page?: number, limit?: number): Promise<{
        projects: ProjectEntity[];
        total: number;
    }>;
    findOne(id: string): Promise<ProjectEntity>;
    findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]>;
}
