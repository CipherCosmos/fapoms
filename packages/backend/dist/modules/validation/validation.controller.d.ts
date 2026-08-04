import { ValidationService, CreateValidationCaseDto } from './validation.service';
import { ValidationStatus } from '@fapoms/shared';
declare class CreateValidationCaseRequestDto implements CreateValidationCaseDto {
    projectBranchId: string;
    assessmentId?: string;
}
declare class AssignReviewerDto {
    reviewerId: string;
}
declare class TransitionValidationCaseDto {
    targetStatus: ValidationStatus;
    remarks?: string;
    notes?: string;
    ocrResult?: any;
}
declare class BulkTransitionValidationCaseDto {
    ids: string[];
    targetStatus: ValidationStatus;
    remarks?: string;
}
export declare class ValidationController {
    private readonly validationService;
    constructor(validationService: ValidationService);
    create(dto: CreateValidationCaseRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./validation-case.entity").ValidationCaseEntity;
    }>;
    findAll(page?: number, limit?: number, projectBranchId?: string): Promise<{
        success: boolean;
        data: import("./validation-case.entity").ValidationCaseEntity[];
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
        data: import("./validation-case.entity").ValidationCaseEntity;
    }>;
    assign(id: string, dto: AssignReviewerDto, req: any): Promise<{
        success: boolean;
        data: import("./validation-case.entity").ValidationCaseEntity;
    }>;
    bulkTransition(dto: BulkTransitionValidationCaseDto, req: any): Promise<{
        success: boolean;
        data: {
            succeeded: {
                id: string;
                from: string;
                to: string;
            }[];
            failed: {
                id: string;
                reason: string;
            }[];
        };
    }>;
    transition(id: string, dto: TransitionValidationCaseDto, req: any): Promise<{
        success: boolean;
        data: import("./validation-case.entity").ValidationCaseEntity;
    }>;
}
export {};
