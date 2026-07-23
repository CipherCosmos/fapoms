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
const project_service_1 = require("../project/project.service");
const project_query_service_1 = require("../project/project-query.service");
const validation_state_machine_1 = require("./validation.state-machine");
const audit_service_1 = require("../../core/audit/audit.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const shared_1 = require("@fapoms/shared");
const workflow_engine_1 = require("../platform/workflow/workflow.engine");
let ValidationService = class ValidationService {
    validationCaseRepository;
    projectQueryService;
    projectService;
    auditService;
    eventPublisher;
    workflowEngine;
    constructor(validationCaseRepository, projectQueryService, projectService, auditService, eventPublisher, workflowEngine) {
        this.validationCaseRepository = validationCaseRepository;
        this.projectQueryService = projectQueryService;
        this.projectService = projectService;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.workflowEngine = workflowEngine;
    }
    onModuleInit() {
        this.workflowEngine.registerWorkflow('validation', [
            { from: [shared_1.ValidationStatus.HUMAN_REVIEW], to: shared_1.ValidationStatus.APPROVED },
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
        const validationCase = this.validationCaseRepository.create({
            projectBranchId: projectBranch.id,
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
            relations: ['projectBranch', 'projectBranch.branch'],
        });
        if (!validationCase) {
            throw new common_1.NotFoundException(`ValidationCase ${id} not found.`);
        }
        return validationCase;
    }
    async findAll(page = 1, limit = 50) {
        const [validationCases, total] = await this.validationCaseRepository.findAndCount({
            where: { isActive: true },
            relations: ['projectBranch', 'projectBranch.branch'],
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
    async executeValidationTransition(id, targetStatus, userId, remarks, notes, ocrResult) {
        const validationCase = await this.findOne(id);
        const prevStatus = validationCase.status;
        let event;
        if (targetStatus === shared_1.ValidationStatus.APPROVED) {
            event = validation_state_machine_1.ValidationStateMachine.approveValidation(validationCase, userId, remarks, notes, ocrResult);
            await this.projectService.completeBranchValidation(validationCase.projectBranch.id, userId);
        }
        else if (targetStatus === shared_1.ValidationStatus.SUBMITTED) {
            event = validation_state_machine_1.ValidationStateMachine.submitValidation(validationCase, userId, remarks, notes, ocrResult);
            await this.projectService.closeBranchProject(validationCase.projectBranch.id, userId);
        }
        else if (targetStatus === shared_1.ValidationStatus.CORRECTION_REQUIRED) {
            event = validation_state_machine_1.ValidationStateMachine.requestCorrection(validationCase, userId, remarks, notes, ocrResult);
            await this.projectService.initiateBranchPlanning(validationCase.projectBranch.id, userId);
        }
        else {
            throw new common_1.BadRequestException(`Invalid validation status: ${targetStatus}`);
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
        else {
            throw new common_1.BadRequestException(`Invalid validation status transition to ${targetStatus}`);
        }
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
    __metadata("design:paramtypes", [typeorm_2.Repository,
        project_query_service_1.ProjectQueryService,
        project_service_1.ProjectService,
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        workflow_engine_1.WorkflowEngine])
], ValidationService);
//# sourceMappingURL=validation.service.js.map