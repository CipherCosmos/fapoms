import { Response } from 'express';
import { ProjectService, CreateProjectDto } from './project.service';
export declare class CreateProjectRequestDto implements CreateProjectDto {
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
export declare class ProjectController {
    private readonly projectService;
    constructor(projectService: ProjectService);
    create(dto: CreateProjectRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./project.entity").ProjectEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: import("./project.entity").ProjectEntity[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
            };
        };
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./project.entity").ProjectEntity;
    }>;
    update(id: string, dto: CreateProjectRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./project.entity").ProjectEntity;
    }>;
    remove(id: string, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    getProjectBranches(id: string): Promise<{
        success: boolean;
        data: {
            assignment: {
                id: string;
                status: import("@fapoms/shared").AssignmentStatus;
                proposedFee: number | null;
                agreedFee: number | null;
                scheduledDate: Date | null;
                assayer: {
                    displayName: string;
                    id: string;
                    assayerCode: string;
                } | undefined;
            } | null;
            assignments: undefined;
            projectId: string;
            branchId: string;
            status: import("@fapoms/shared").ProjectBranchStatus;
            priority: import("@fapoms/shared").Priority;
            zoneId: string | null;
            scheduledDate: Date | null;
            remarks: string | null;
            packetCount: number | null;
            project: import("./project.entity").ProjectEntity;
            branch: import("../branch/branch.entity").BranchEntity;
            id: string;
            createdBy: string;
            createdAt: Date;
            updatedBy: string;
            updatedAt: Date;
            version: number;
            isActive: boolean;
        }[];
    }>;
    associateBranches(id: string, dto: {
        branchIds: string[];
    }, req: any): Promise<{
        success: boolean;
        data: import("./project-branch.entity").ProjectBranchEntity[];
    }>;
    uploadBranches(id: string, file: any, req: any): Promise<{
        success: boolean;
        data: import("./project-branch.entity").ProjectBranchEntity[];
    }>;
    downloadTemplate(id: string, res: Response): Promise<void>;
    removeBranch(id: string, pbId: string, req: any): Promise<{
        success: boolean;
        data: import("./project-branch.entity").ProjectBranchEntity[];
    }>;
}
