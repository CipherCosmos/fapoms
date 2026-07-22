import { ProjectService, CreateProjectDto } from './project.service';
export declare class ProjectController {
    private readonly projectService;
    constructor(projectService: ProjectService);
    create(dto: CreateProjectDto, req: any): Promise<{
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
    update(id: string, dto: CreateProjectDto, req: any): Promise<{
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
        data: import("./project-branch.entity").ProjectBranchEntity[];
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
    removeBranch(id: string, pbId: string, req: any): Promise<{
        success: boolean;
        data: import("./project-branch.entity").ProjectBranchEntity[];
    }>;
}
