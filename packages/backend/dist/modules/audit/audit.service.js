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
exports.AuditService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const audit_entity_1 = require("./audit.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const billing_engine_service_1 = require("../billing-engine/billing-engine.service");
const audit_history_service_1 = require("../audit-history/audit-history.service");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
let AuditService = class AuditService {
    auditRepository;
    assignmentRepository;
    billingEngine;
    historyService;
    eventPublisher;
    constructor(auditRepository, assignmentRepository, billingEngine, historyService, eventPublisher) {
        this.auditRepository = auditRepository;
        this.assignmentRepository = assignmentRepository;
        this.billingEngine = billingEngine;
        this.historyService = historyService;
        this.eventPublisher = eventPublisher;
    }
    async startAudit(assignmentId, assayerId, projectId, branchId, scheduledDate) {
        const audit = this.auditRepository.create({
            assignmentId,
            assayerId,
            projectId,
            branchId,
            status: 'IN_PROGRESS',
            scheduledDate,
            slaStatus: 'MET',
        });
        const saved = await this.auditRepository.save(audit);
        await this.historyService.createRecord({
            auditId: saved.id,
            assayerId,
            clientId: 'system',
            projectId,
            status: 'IN_PROGRESS',
            outcome: 'PENDING',
            startTime: new Date(),
            slaStatus: 'MET',
        });
        this.eventPublisher.publish('audit:started', {
            eventType: 'audit:started',
            aggregateId: saved.id,
            assayerId,
            assignmentId,
            projectId,
            branchId,
            payload: { id: saved.id, status: 'IN_PROGRESS', scheduledDate },
        });
        return saved;
    }
    async closeAudit(id, baseFee, travelAllowance) {
        const audit = await this.auditRepository.findOne({ where: { id } });
        if (!audit)
            throw new common_1.NotFoundException(`Audit ${id} not found.`);
        let resolvedBaseFee = baseFee;
        let resolvedTravelAllowance = travelAllowance;
        if (resolvedBaseFee === undefined || resolvedTravelAllowance === undefined) {
            const assignment = audit.assignmentId
                ? await this.assignmentRepository.findOne({ where: { id: audit.assignmentId } }).catch(() => null)
                : null;
            const agreedTotal = assignment ? Number(assignment.agreedFee ?? assignment.proposedFee ?? 0) : 0;
            if (resolvedBaseFee === undefined)
                resolvedBaseFee = agreedTotal;
            if (resolvedTravelAllowance === undefined)
                resolvedTravelAllowance = 0;
        }
        audit.status = 'CLOSED';
        audit.completionDate = new Date();
        const saved = await this.auditRepository.save(audit);
        let payableId;
        if (saved.assignmentId) {
            const result = await this.billingEngine.syncPayableForAssignment(saved.assignmentId, 'system');
            payableId = result.payableId;
        }
        this.eventPublisher.publish('audit:closed', {
            eventType: 'audit:closed',
            aggregateId: id,
            assayerId: saved.assayerId,
            payableId,
            payload: { id, status: 'CLOSED', completionDate: saved.completionDate, baseFee: resolvedBaseFee, travelAllowance: resolvedTravelAllowance },
        });
        return saved;
    }
};
exports.AuditService = AuditService;
exports.AuditService = AuditService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(audit_entity_1.AuditEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        billing_engine_service_1.BillingEngineService,
        audit_history_service_1.AuditHistoryService,
        domain_event_publisher_1.DomainEventPublisher])
], AuditService);
//# sourceMappingURL=audit.service.js.map