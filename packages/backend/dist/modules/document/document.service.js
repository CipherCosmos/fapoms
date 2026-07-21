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
exports.DocumentService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const document_entity_1 = require("./document.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let DocumentService = class DocumentService {
    documentRepository;
    projectBranchRepository;
    auditService;
    constructor(documentRepository, projectBranchRepository, auditService) {
        this.documentRepository = documentRepository;
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
        const doc = this.documentRepository.create({
            projectBranchId: projectBranch.id,
            fileName: dto.fileName,
            filePath: dto.filePath,
            fileSize: dto.fileSize,
            mimeType: dto.mimeType ?? null,
            type: dto.type,
            status: shared_1.DocumentStatus.UPLOADED,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.documentRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'DOCUMENT_UPLOADED',
            entityType: 'DOCUMENT',
            entityId: saved.id,
            userId,
            remarks: `Uploaded document ${dto.fileName} for branch link.`,
        });
        return saved;
    }
    async findOne(id) {
        const doc = await this.documentRepository.findOne({
            where: { id, isActive: true },
            relations: ['projectBranch', 'projectBranch.branch'],
        });
        if (!doc) {
            throw new common_1.NotFoundException(`Document ${id} not found.`);
        }
        return doc;
    }
    async updateStatus(id, status, userId) {
        const doc = await this.findOne(id);
        const prevStatus = doc.status;
        doc.status = status;
        doc.updatedBy = userId;
        const saved = await this.documentRepository.save(doc);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: `DOCUMENT_${status}`,
            entityType: 'DOCUMENT',
            entityId: saved.id,
            previousState: prevStatus,
            newState: status,
            userId,
            remarks: `Transitioned document ${doc.fileName} to ${status}.`,
        });
        return saved;
    }
    async findByProjectBranch(projectBranchId) {
        return this.documentRepository.find({
            where: { projectBranchId, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }
};
exports.DocumentService = DocumentService;
exports.DocumentService = DocumentService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(document_entity_1.DocumentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], DocumentService);
//# sourceMappingURL=document.service.js.map