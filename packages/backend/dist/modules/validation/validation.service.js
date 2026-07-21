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
const project_branch_entity_1 = require("../project/project-branch.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let ValidationService = class ValidationService {
    validationCaseRepository;
    projectBranchRepository;
    auditService;
    constructor(validationCaseRepository, projectBranchRepository, auditService) {
        this.validationCaseRepository = validationCaseRepository;
        this.projectBranchRepository = projectBranchRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const projectBranch = await this.projectBranchRepository.findOne({
            where: { id: dto.projectBranchId, isActive: true },
        });
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
    async transition(id, targetStatus, userId, remarks, notes, ocrResult) {
        const validationCase = await this.findOne(id);
        const prevStatus = validationCase.status;
        if (!(0, shared_1.isValidTransition)(shared_1.VALIDATION_TRANSITIONS, prevStatus, targetStatus)) {
            throw new common_1.BadRequestException(`Invalid Transition: Cannot transition validation case from ${prevStatus} to ${targetStatus}.`);
        }
        validationCase.status = targetStatus;
        if (remarks)
            validationCase.remarks = remarks;
        if (notes)
            validationCase.correctionNotes = notes;
        if (ocrResult)
            validationCase.ocrResult = ocrResult;
        validationCase.updatedBy = userId;
        if (targetStatus === shared_1.ValidationStatus.APPROVED) {
            validationCase.reviewedAt = new Date();
            validationCase.projectBranch.status = shared_1.ProjectBranchStatus.VALIDATION_COMPLETED;
            await this.projectBranchRepository.save(validationCase.projectBranch);
        }
        else if (targetStatus === shared_1.ValidationStatus.SUBMITTED) {
            validationCase.projectBranch.status = shared_1.ProjectBranchStatus.CLOSED;
            await this.projectBranchRepository.save(validationCase.projectBranch);
        }
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
        return saved;
    }
};
exports.ValidationService = ValidationService;
exports.ValidationService = ValidationService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(validation_case_entity_1.ValidationCaseEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], ValidationService);
//# sourceMappingURL=validation.service.js.map