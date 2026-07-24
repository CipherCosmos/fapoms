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
const billing_service_1 = require("../billing/billing.service");
const ledger_service_1 = require("../ledger/ledger.service");
const audit_history_service_1 = require("../audit-history/audit-history.service");
let AuditService = class AuditService {
    auditRepository;
    billingService;
    ledgerService;
    historyService;
    constructor(auditRepository, billingService, ledgerService, historyService) {
        this.auditRepository = auditRepository;
        this.billingService = billingService;
        this.ledgerService = ledgerService;
        this.historyService = historyService;
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
        return saved;
    }
    async closeAudit(id, baseFee, travelAllowance) {
        const audit = await this.auditRepository.findOne({ where: { id } });
        if (!audit)
            throw new common_1.NotFoundException(`Audit ${id} not found.`);
        audit.status = 'CLOSED';
        audit.completionDate = new Date();
        const saved = await this.auditRepository.save(audit);
        const bill = await this.billingService.createBillingRecord({
            auditId: saved.id,
            assayerId: saved.assayerId,
            baseFee,
            travelAllowance,
            penalties: 0,
            invoiceStatus: 'ISSUED',
        });
        await this.ledgerService.addEntry(saved.assayerId, 'CREDIT', bill.netPayable, bill.id);
        return saved;
    }
};
exports.AuditService = AuditService;
exports.AuditService = AuditService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(audit_entity_1.AuditEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        billing_service_1.BillingService,
        ledger_service_1.LedgerService,
        audit_history_service_1.AuditHistoryService])
], AuditService);
//# sourceMappingURL=audit.service.js.map