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
exports.BillingService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const billing_record_entity_1 = require("./billing-record.entity");
const domain_event_publisher_1 = require("../../core/events/domain-event.publisher");
let BillingService = class BillingService {
    billingRepository;
    eventPublisher;
    constructor(billingRepository, eventPublisher) {
        this.billingRepository = billingRepository;
        this.eventPublisher = eventPublisher;
    }
    async createBillingRecord(dto) {
        const base = Number(dto.baseFee || 0);
        const travel = Number(dto.travelAllowance || 0);
        const penalty = Number(dto.penalties || 0);
        const gstRate = 0.18;
        const tdsRate = 0.10;
        const taxableAmount = base + travel - penalty;
        const gstVal = taxableAmount * gstRate;
        const tdsVal = taxableAmount * tdsRate;
        const netVal = taxableAmount + gstVal - tdsVal;
        const record = this.billingRepository.create({
            ...dto,
            baseFee: base,
            travelAllowance: travel,
            penalties: penalty,
            gst: gstVal,
            tds: tdsVal,
            netPayable: netVal,
            invoiceStatus: dto.invoiceStatus || 'DRAFT',
        });
        const saved = await this.billingRepository.save(record);
        try {
            this.eventPublisher.publish('billing:created', {
                eventType: 'billing:created',
                billingId: saved.id,
                assayerId: saved.assayerId,
                assignmentId: saved.assignmentId,
                baseFee: saved.baseFee,
                netPayable: saved.netPayable,
                invoiceStatus: saved.invoiceStatus,
                timestamp: new Date(),
            });
        }
        catch (err) {
            console.error('Failed to publish billing:created event:', err);
        }
        return saved;
    }
    async getAssayerBilling(assayerId) {
        return this.billingRepository.find({ where: { assayerId } });
    }
};
exports.BillingService = BillingService;
exports.BillingService = BillingService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(billing_record_entity_1.BillingRecord)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        domain_event_publisher_1.DomainEventPublisher])
], BillingService);
//# sourceMappingURL=billing.service.js.map