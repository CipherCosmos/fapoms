import { AssignmentService, CreateAssignmentDto, UpdateAssignmentDetailsDto } from './assignment.service';
export declare class AssignmentController {
    private readonly assignmentService;
    constructor(assignmentService: AssignmentService);
    findByAssayer(assayerId: string): Promise<{
        success: boolean;
        items: import("./assignment.entity").AssignmentEntity[];
    }>;
    checkIn(id: string, dto: any, req: any): Promise<{
        success: boolean;
        error: string | undefined;
        message: string | undefined;
        syncToken?: undefined;
        timestamp?: undefined;
        data?: undefined;
    } | {
        success: boolean;
        message: string | undefined;
        syncToken: string | null;
        timestamp: any;
        data: import("./assignment.entity").AssignmentEntity;
        error?: undefined;
    }>;
    create(dto: CreateAssignmentDto, req: any): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity;
    }>;
    findAll(page?: number, limit?: number, status?: string, projectBranchStatus?: string, assessmentStatus?: string): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
            };
        };
    }>;
    getDashboardSummary(): Promise<{
        success: boolean;
        data: any;
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity;
    }>;
    update(id: string, dto: UpdateAssignmentDetailsDto, req: any): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity;
    }>;
    transition(id: string, dto: any, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    getTimeline(id: string): Promise<{
        success: boolean;
        data: any[];
    }>;
    addComment(id: string, body: {
        comment: string;
    }, req: any): Promise<{
        success: boolean;
        data: import("./assignment-comment.entity").AssignmentCommentEntity;
    }>;
}
