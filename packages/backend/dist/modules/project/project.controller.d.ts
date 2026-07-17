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
    getProjectBranches(id: string): Promise<{
        success: boolean;
        data: import("./project-branch.entity").ProjectBranchEntity[];
    }>;
}
