import { OnModuleInit } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { ValidationStatus } from '@fapoms/shared';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
export interface CreateValidationCaseDto {
    projectBranchId: string;
}
export declare class ValidationService implements OnModuleInit {
    private readonly validationCaseRepository;
    private readonly projectQueryService;
    private readonly projectService;
    private readonly auditService;
    private readonly eventPublisher;
    private readonly workflowEngine;
    constructor(validationCaseRepository: Repository<ValidationCaseEntity>, projectQueryService: ProjectQueryService, projectService: ProjectService, auditService: AuditService, eventPublisher: DomainEventPublisher, workflowEngine: WorkflowEngine);
    onModuleInit(): void;
    create(dto: CreateValidationCaseDto, userId: string): Promise<ValidationCaseEntity>;
    findOne(id: string): Promise<ValidationCaseEntity>;
    findAll(page?: number, limit?: number): Promise<{
        validationCases: ValidationCaseEntity[];
        total: number;
    }>;
    assign(id: string, reviewerId: string, userId: string): Promise<ValidationCaseEntity>;
    autoBalanceUnassignedCases(availableValidatorIds: string[], userId: string): Promise<number>;
    private executeValidationTransition;
    transition(id: string, targetStatus: ValidationStatus, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity>;
    approveValidation(id: string, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity>;
    requestCorrection(id: string, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity>;
    submitValidation(id: string, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity>;
}
