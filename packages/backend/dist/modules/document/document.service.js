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
const assessment_entity_1 = require("../project/assessment.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
const notification_service_1 = require("../notifications/notification.service");
const push_notification_service_1 = require("../notifications/push-notification.service");
const shared_1 = require("@fapoms/shared");
let DocumentService = class DocumentService {
    documentRepository;
    assessmentRepository;
    assignmentRepository;
    auditService;
    eventPublisher;
    notificationService;
    pushNotificationService;
    constructor(documentRepository, assessmentRepository, assignmentRepository, auditService, eventPublisher, notificationService, pushNotificationService) {
        this.documentRepository = documentRepository;
        this.assessmentRepository = assessmentRepository;
        this.assignmentRepository = assignmentRepository;
        this.auditService = auditService;
        this.eventPublisher = eventPublisher;
        this.notificationService = notificationService;
        this.pushNotificationService = pushNotificationService;
    }
    async create(dto, userId) {
        const assessment = await this.assessmentRepository.findOne({
            where: { id: dto.assessmentId, isActive: true },
        });
        if (!assessment) {
            throw new common_1.NotFoundException(`Assessment ${dto.assessmentId} not found.`);
        }
        const doc = this.documentRepository.create({
            assessmentId: assessment.id,
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
            remarks: `Uploaded document ${dto.fileName} for assessment.`,
        });
        try {
            this.eventPublisher.publish('document:uploaded', {
                eventType: 'document:uploaded',
                documentId: saved.id,
                assessmentId: saved.assessmentId,
                fileName: saved.fileName,
                fileSize: saved.fileSize,
                type: saved.type,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish document:uploaded event:', err);
        }
        return saved;
    }
    async findOne(id) {
        const doc = await this.documentRepository.findOne({
            where: { id, isActive: true },
            relations: ['assessment', 'assessment.branch', 'assessment.project'],
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
        try {
            this.eventPublisher.publish('document:status-changed', {
                eventType: 'document:status-changed',
                documentId: saved.id,
                assessmentId: saved.assessmentId,
                fileName: saved.fileName,
                previousStatus: prevStatus,
                newStatus: status,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish document:status-changed event:', err);
        }
        return saved;
    }
    async findByAssessment(assessmentId) {
        return this.documentRepository.find({
            where: { assessmentId, isActive: true },
            order: { createdAt: 'DESC' },
        });
    }
    async findByProject(projectId) {
        const assessmentIds = await this.assessmentRepository.find({
            where: { projectId, isActive: true },
            select: ['id'],
        });
        return this.documentRepository.find({
            where: { assessmentId: assessmentIds.length > 0 ? assessmentIds.map(a => a.id) : undefined, isActive: true },
            relations: ['assessment', 'assessment.branch'],
            order: { createdAt: 'DESC' },
        });
    }
    async dispatchDocument(id, userId) {
        const doc = await this.findOne(id);
        if (doc.status !== shared_1.DocumentStatus.UPLOADED) {
            throw new common_1.NotFoundException(`Document ${id} cannot be dispatched from status ${doc.status}.`);
        }
        const saved = await this.updateStatus(id, shared_1.DocumentStatus.DISPATCHED, userId);
        if (!doc.assessmentId)
            return saved;
        const assignment = await this.assignmentRepository.findOne({
            where: { assessmentId: doc.assessmentId, isActive: true },
            relations: ['assayer'],
        });
        if (assignment?.assayer) {
            try {
                await this.notificationService.create({
                    userId: assignment.assayerId,
                    title: 'New Audit PDF',
                    message: `Audit PDF "${doc.fileName}" has been dispatched to you for assessment.`,
                    link: `/assignments/${assignment.id}`,
                }, userId);
                await this.pushNotificationService.sendToUser(assignment.assayerId, 'New Audit PDF', `Audit PDF "${doc.fileName}" has been assigned to you. Open your schedule to view and download.`, { documentId: doc.id, assignmentId: assignment.id, type: 'document_dispatched' });
            }
            catch (err) {
                console.error('Failed to send dispatch notification:', err);
            }
        }
        return saved;
    }
    async receiveDocument(id, userId) {
        const doc = await this.findOne(id);
        if (doc.status !== shared_1.DocumentStatus.DISPATCHED) {
            throw new common_1.NotFoundException(`Document ${id} cannot be received from status ${doc.status}.`);
        }
        const saved = await this.updateStatus(id, shared_1.DocumentStatus.RECEIVED, userId);
        try {
            this.eventPublisher.publish('document:received', {
                eventType: 'document:received',
                documentId: saved.id,
                assessmentId: saved.assessmentId,
                fileName: saved.fileName,
                userId,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish document:received event:', err);
        }
        return saved;
    }
    async findDataEntryQueue() {
        const docs = await this.documentRepository.find({
            where: { type: shared_1.DocumentType.AUDITED_RETURN_PDF, isActive: true },
            relations: ['assessment', 'assessment.branch', 'assessment.project'],
            order: { createdAt: 'ASC' },
        });
        const grouped = new Map();
        for (const doc of docs) {
            const key = doc.assessmentId || 'unknown';
            if (!grouped.has(key)) {
                grouped.set(key, {
                    project: doc.assessment?.project?.name || 'Unknown',
                    branch: doc.assessment?.branch?.name || 'Unknown',
                    documents: [],
                });
            }
            grouped.get(key).documents.push(doc);
        }
        return Array.from(grouped.values());
    }
    async getDocumentStats() {
        const all = await this.documentRepository.find({ where: { isActive: true } });
        return {
            total: all.length,
            uploaded: all.filter(d => d.status === shared_1.DocumentStatus.UPLOADED).length,
            dispatched: all.filter(d => d.status === shared_1.DocumentStatus.DISPATCHED).length,
            received: all.filter(d => d.status === shared_1.DocumentStatus.RECEIVED).length,
        };
    }
};
exports.DocumentService = DocumentService;
exports.DocumentService = DocumentService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(document_entity_1.DocumentEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assessment_entity_1.AssessmentEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService,
        domain_event_publisher_1.DomainEventPublisher,
        notification_service_1.NotificationService,
        push_notification_service_1.PushNotificationService])
], DocumentService);
//# sourceMappingURL=document.service.js.map