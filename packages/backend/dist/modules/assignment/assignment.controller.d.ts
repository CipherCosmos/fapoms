import { AssignmentService, CreateAssignmentDto, UpdateAssignmentDetailsDto, TransitionAssignmentDto } from './assignment.service';
export declare class AssignmentController {
    private readonly assignmentService;
    constructor(assignmentService: AssignmentService);
    findByAssayer(assayerId: string): Promise<{
        success: boolean;
        items: import("./assignment.entity").AssignmentEntity[];
    }>;
    checkIn(id: string, body: {
        lat: number;
        lng: number;
        syncToken?: string;
        timestamp?: string;
    }): Promise<{
        success: boolean;
        error: string;
        message: string;
        syncToken?: undefined;
        timestamp?: undefined;
    } | {
        success: boolean;
        message: string;
        syncToken: string;
        timestamp: string;
        error?: undefined;
    }>;
    create(dto: CreateAssignmentDto, req: any): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity;
    }>;
    findAll(page?: number, limit?: number, status?: string): Promise<{
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
    transition(id: string, dto: TransitionAssignmentDto, req: any): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity;
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
