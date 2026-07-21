import { ValidationService, CreateValidationCaseDto } from './validation.service';
import { ValidationStatus } from '@fapoms/shared';
declare class CreateValidationCaseRequestDto implements CreateValidationCaseDto {
    projectBranchId: string;
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
export declare class ValidationController {
    private readonly validationService;
    constructor(validationService: ValidationService);
    create(dto: CreateValidationCaseRequestDto, req: any): Promise<{
        success: boolean;
        data: import("./validation-case.entity").ValidationCaseEntity;
    }>;
    findAll(page?: number, limit?: number): Promise<{
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
    transition(id: string, dto: TransitionValidationCaseDto, req: any): Promise<{
        success: boolean;
        data: import("./validation-case.entity").ValidationCaseEntity;
    }>;
}
export {};
