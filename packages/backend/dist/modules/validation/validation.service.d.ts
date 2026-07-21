import { Repository } from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { ValidationStatus } from '@fapoms/shared';
export interface CreateValidationCaseDto {
    projectBranchId: string;
}
export declare class ValidationService {
    private readonly validationCaseRepository;
    private readonly projectBranchRepository;
    private readonly auditService;
    constructor(validationCaseRepository: Repository<ValidationCaseEntity>, projectBranchRepository: Repository<ProjectBranchEntity>, auditService: AuditService);
    create(dto: CreateValidationCaseDto, userId: string): Promise<ValidationCaseEntity>;
    findOne(id: string): Promise<ValidationCaseEntity>;
    findAll(page?: number, limit?: number): Promise<{
        validationCases: ValidationCaseEntity[];
        total: number;
    }>;
    assign(id: string, reviewerId: string, userId: string): Promise<ValidationCaseEntity>;
    transition(id: string, targetStatus: ValidationStatus, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity>;
}
