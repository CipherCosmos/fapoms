import { OnModuleInit } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
export interface CreateProjectDto {
    name: string;
    projectNumber: string;
    description?: string;
    clientId: string;
    priority: string;
    startDate?: string;
    endDate?: string;
    budget?: number;
    scope?: string;
    requiredSkills?: string[];
    requiredCertifications?: string[];
    sla?: Record<string, any>;
    risks?: Record<string, any>;
    milestones?: Record<string, any>;
    dependencies?: Record<string, any>;
    status?: string;
}
export declare class ProjectService implements OnModuleInit {
    private readonly projectRepository;
    private readonly projectBranchRepository;
    private readonly branchRepository;
    private readonly auditService;
    private readonly workflowEngine;
    constructor(projectRepository: Repository<ProjectEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, branchRepository: Repository<BranchEntity>, auditService: AuditService, workflowEngine: WorkflowEngine);
    onModuleInit(): void;
    create(dto: CreateProjectDto, userId: string): Promise<ProjectEntity>;
    findAll(page?: number, limit?: number): Promise<{
        projects: ProjectEntity[];
        total: number;
    }>;
    findOne(id: string): Promise<ProjectEntity>;
    update(id: string, dto: CreateProjectDto, userId: string): Promise<ProjectEntity>;
    remove(id: string, userId: string): Promise<void>;
    findProjectBranches(projectId: string): Promise<ProjectBranchEntity[]>;
    associateBranches(projectId: string, branchIds: string[], userId: string): Promise<ProjectBranchEntity[]>;
    uploadBranchesFromExcel(projectId: string, fileBuffer: Buffer, userId: string): Promise<ProjectBranchEntity[]>;
}
