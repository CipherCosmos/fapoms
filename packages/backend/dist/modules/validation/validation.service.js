"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const validation_case_entity_1 = require("./validation-case.entity");
const assessment_entity_1 = require("../project/assessment.entity");
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const validation_state_machine_1 = require("./validation.state-machine");
const audit_service_1 = require("../../core/audit/audit.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const shared_1 = require("@fapoms/shared");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
let ValidationService = class ValidationService {
    validationCaseRepository;
    assessmentRepository;
    projectQueryService;
    projectService;
    auditService;
    eventPublisher;
    workflowEngine;
    constructor(validationCaseRepository, assessmentRepository, projectQueryService, projectService, auditService, eventPublisher, workflowEngine) {
        this.validationCaseRepository = validationCaseRepository;
        this.assessmentRepository = assessmentRepository;
        this.projectQueryService = projectQueryService;
        this.projectService = projectService;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.workflowEngine = workflowEngine;
    }
    onModuleInit() {
        this.workflowEngine.registerWorkflow('validation', [
            { from: [shared_1.ValidationStatus.PENDING, shared_1.ValidationStatus.ASSIGNED], to: shared_1.ValidationStatus.HUMAN_REVIEW },
            { from: [shared_1.ValidationStatus.HUMAN_REVIEW, shared_1.ValidationStatus.ASSIGNED, shared_1.ValidationStatus.PENDING], to: shared_1.ValidationStatus.APPROVED },
            { from: [shared_1.ValidationStatus.HUMAN_REVIEW], to: shared_1.ValidationStatus.CORRECTION_REQUIRED },
            { from: [shared_1.ValidationStatus.CORRECTION_REQUIRED], to: shared_1.ValidationStatus.HUMAN_REVIEW },
            { from: [shared_1.ValidationStatus.APPROVED], to: shared_1.ValidationStatus.SUBMITTED },
        ]);
    }
    async create(dto, userId) {
        const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);
        if (!projectBranch) {
            throw new common_1.NotFoundException(`ProjectBranch ${dto.projectBranchId} not found.`);
        }
        let assessmentId = dto.assessmentId ?? null;
        if (!assessmentId) {
            const asmt = await this.assessmentRepository.findOne({
                where: { projectId: projectBranch.projectId, branchId: projectBranch.branchId, isActive: true },
            });
            if (asmt)
                assessmentId = asmt.id;
        }
        const validationCase = this.validationCaseRepository.create({
            projectBranchId: projectBranch.id,
            assessmentId,
            status: shared_1.ValidationStatus.PENDING,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.validationCaseRepository.save(validationCase);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.WORKFLOW,
            eventType: 'VALIDATION_STARTED',
            entityType: 'VALIDATION',
            entityId: saved.id,
            userId,
            remarks: `Validation pipeline initialized for project branch.`,
        });
        return saved;
    }
    async findOne(id) {
        const validationCase = await this.validationCaseRepository.findOne({
            where: { id, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch'],
        });
        if (!validationCase) {
            throw new common_1.NotFoundException(`ValidationCase ${id} not found.`);
        }
        return validationCase;
    }
    async findAll(page = 1, limit = 50, projectBranchId) {
        const [validationCases, total] = await this.validationCaseRepository.findAndCount({
            where: { isActive: true, ...(projectBranchId ? { projectBranchId } : {}) },
            relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch'],
            order: { createdAt: 'DESC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { validationCases, total };
    }
    async assign(id, reviewerId, userId) {
        const validationCase = await this.findOne(id);
        const prevStatus = validationCase.status;
        if (!(0, shared_1.isValidTransition)(shared_1.VALIDATION_TRANSITIONS, prevStatus, shared_1.ValidationStatus.ASSIGNED)) {
            throw new common_1.BadRequestException(`Invalid Transition: Cannot transition validation case from ${prevStatus} to ASSIGNED.`);
        }
        validationCase.status = shared_1.ValidationStatus.ASSIGNED;
        validationCase.reviewerId = reviewerId;
        validationCase.updatedBy = userId;
        const saved = await this.validationCaseRepository.save(validationCase);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.WORKFLOW,
            eventType: 'VALIDATION_ASSIGNED',
            entityType: 'VALIDATION',
            entityId: saved.id,
            previousState: prevStatus,
            newState: shared_1.ValidationStatus.ASSIGNED,
            userId,
            remarks: `Validation case assigned to reviewer ${reviewerId}.`,
        });
        return saved;
    }
    async autoBalanceUnassignedCases(availableValidatorIds, userId) {
        if (availableValidatorIds.length === 0)
            return 0;
        const unassignedCases = await this.validationCaseRepository.find({
            where: { status: shared_1.ValidationStatus.PENDING, reviewerId: undefined, isActive: true },
            order: { createdAt: 'ASC' },
        });
        let assignedCount = 0;
        for (let i = 0; i < unassignedCases.length; i++) {
            const caseItem = unassignedCases[i];
            const validatorId = availableValidatorIds[i % availableValidatorIds.length];
            caseItem.reviewerId = validatorId;
            caseItem.status = shared_1.ValidationStatus.ASSIGNED;
            caseItem.updatedBy = userId;
            await this.validationCaseRepository.save(caseItem);
            assignedCount++;
        }
        return assignedCount;
    }
    async executeValidationTransition(id, targetStatus, userId, remarks, notes, ocrResult, role = shared_1.SystemRole.SUPER_ADMINISTRATOR) {
        const validationCase = await this.findOne(id);
        const prevStatus = validationCase.status;
        let event;
        if (targetStatus === shared_1.ValidationStatus.APPROVED) {
            event = validation_state_machine_1.ValidationStateMachine.approveValidation(validationCase, userId, remarks, notes, ocrResult);
        }
        else if (targetStatus === shared_1.ValidationStatus.SUBMITTED) {
            event = validation_state_machine_1.ValidationStateMachine.submitValidation(validationCase, userId, remarks, notes, ocrResult);
        }
        else if (targetStatus === shared_1.ValidationStatus.CORRECTION_REQUIRED) {
            event = validation_state_machine_1.ValidationStateMachine.requestCorrection(validationCase, userId, remarks, notes, ocrResult);
        }
        else {
            throw new common_1.BadRequestException(`Invalid validation status: ${targetStatus}`);
        }
        return this.workflowEngine.executeCommand('validation', validationCase.id, `${targetStatus}_Command`, prevStatus, targetStatus, userId, role, [], async () => {
            if (targetStatus === shared_1.ValidationStatus.APPROVED) {
                await this.projectService.completeBranchValidation(validationCase.projectBranch.id, userId);
            }
            else if (targetStatus === shared_1.ValidationStatus.SUBMITTED) {
                await this.projectService.closeBranchProject(validationCase.projectBranch.id, userId);
            }
            else if (targetStatus === shared_1.ValidationStatus.CORRECTION_REQUIRED) {
                await this.projectService.initiateBranchPlanning(validationCase.projectBranch.id, userId);
            }
            if (validationCase.assessmentId && validationCase.assessment) {
                if (targetStatus === shared_1.ValidationStatus.APPROVED) {
                    validationCase.assessment.status = shared_1.AssessmentStatus.REPORT_FINALIZED;
                }
                else if (targetStatus === shared_1.ValidationStatus.CORRECTION_REQUIRED) {
                    validationCase.assessment.status = shared_1.AssessmentStatus.DATA_ENTRY_IN_PROGRESS;
                }
                else if (targetStatus === shared_1.ValidationStatus.SUBMITTED) {
                    validationCase.assessment.status = shared_1.AssessmentStatus.PENDING_HEAD_APPROVAL;
                }
                validationCase.assessment.updatedBy = userId;
                await this.assessmentRepository.save(validationCase.assessment);
            }
            validationCase.updatedBy = userId;
            const saved = await this.validationCaseRepository.save(validationCase);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.WORKFLOW,
                eventType: `VALIDATION_${targetStatus}`,
                entityType: 'VALIDATION',
                entityId: saved.id,
                previousState: prevStatus,
                newState: targetStatus,
                userId,
                remarks: remarks ?? `Transitioned validation case to ${targetStatus}`,
            });
            return { saved, event };
        });
    }
    async transition(id, targetStatus, userId, remarks, notes, ocrResult) {
        if (targetStatus === shared_1.ValidationStatus.APPROVED) {
            return this.approveValidation(id, userId, remarks, notes, ocrResult);
        }
        else if (targetStatus === shared_1.ValidationStatus.CORRECTION_REQUIRED) {
            return this.requestCorrection(id, userId, remarks, notes, ocrResult);
        }
        else if (targetStatus === shared_1.ValidationStatus.SUBMITTED) {
            return this.submitValidation(id, userId, remarks, notes, ocrResult);
        }
        else if (targetStatus === shared_1.ValidationStatus.HUMAN_REVIEW) {
            return this.moveToReview(id, userId, remarks);
        }
        else {
            throw new common_1.BadRequestException(`Invalid validation status transition to ${targetStatus}`);
        }
    }
    async moveToReview(id, userId, remarks) {
        const validationCase = await this.findOne(id);
        const prevStatus = validationCase.status;
        return this.workflowEngine.executeCommand('validation', validationCase.id, 'HUMAN_REVIEW_Command', prevStatus, shared_1.ValidationStatus.HUMAN_REVIEW, userId, shared_1.SystemRole.SUPER_ADMINISTRATOR, [], async () => {
            const event = validation_state_machine_1.ValidationStateMachine.moveToReview(validationCase, userId, remarks);
            validationCase.updatedBy = userId;
            const saved = await this.validationCaseRepository.save(validationCase);
            this.eventPublisher.publish(event.constructor.name, event);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.WORKFLOW,
                eventType: 'VALIDATION_HUMAN_REVIEW',
                entityType: 'VALIDATION',
                entityId: saved.id,
                previousState: prevStatus,
                newState: shared_1.ValidationStatus.HUMAN_REVIEW,
                userId,
                remarks: remarks ?? 'Ready for review',
            });
            return saved;
        });
    }
    async getOrAdvanceForHandBack(projectBranchId, assessmentId, userId) {
        const validationCase = await this.getOrCreateForBranch(projectBranchId, assessmentId, userId);
        if (validationCase.status === shared_1.ValidationStatus.CORRECTION_REQUIRED || validationCase.status === shared_1.ValidationStatus.PENDING) {
            return this.moveToReview(validationCase.id, userId, 'Data entry complete — ready for review');
        }
        return validationCase;
    }
    async getOrCreateForBranch(projectBranchId, assessmentId, userId) {
        const existing = await this.validationCaseRepository.findOne({
            where: { projectBranchId, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch'],
        });
        if (existing)
            return existing;
        const created = await this.create({ projectBranchId, assessmentId: assessmentId ?? undefined }, userId);
        return this.findOne(created.id);
    }
    async approveValidation(id, userId, remarks, notes, ocrResult) {
        const { saved, event } = await this.executeValidationTransition(id, shared_1.ValidationStatus.APPROVED, userId, remarks, notes, ocrResult);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async requestCorrection(id, userId, remarks, notes, ocrResult) {
        const { saved, event } = await this.executeValidationTransition(id, shared_1.ValidationStatus.CORRECTION_REQUIRED, userId, remarks, notes, ocrResult);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
    async submitValidation(id, userId, remarks, notes, ocrResult) {
        const { saved, event } = await this.executeValidationTransition(id, shared_1.ValidationStatus.SUBMITTED, userId, remarks, notes, ocrResult);
        if (event)
            this.eventPublisher.publish(event.constructor.name, event);
        return saved;
    }
};
exports.ValidationService = ValidationService;
exports.ValidationService = ValidationService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(validation_case_entity_1.ValidationCaseEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assessment_entity_1.AssessmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        project_query_service_1.ProjectQueryService,
        project_service_1.ProjectService,
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        workflow_engine_1.WorkflowEngine])
], ValidationService);
//# sourceMappingURL=validation.service.js.map