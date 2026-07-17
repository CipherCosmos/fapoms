import { AssignmentService, CreateAssignmentDto } from './assignment.service';
export declare class AssignmentController {
    private readonly assignmentService;
    constructor(assignmentService: AssignmentService);
    create(dto: CreateAssignmentDto, req: any): Promise<{
        success: boolean;
        data: import("./assignment.entity").AssignmentEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
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
}
