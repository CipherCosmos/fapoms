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
const audit_event_entity_1 = require("./audit-event.entity");
let AuditService = class AuditService {
    auditRepository;
    constructor(auditRepository) {
        this.auditRepository = auditRepository;
    }
    async recordEvent(dto) {
        const event = this.auditRepository.create({
            category: dto.category,
            eventType: dto.eventType,
            entityType: dto.entityType,
            entityId: dto.entityId,
            previousState: dto.previousState ?? null,
            newState: dto.newState ?? null,
            userId: dto.userId ?? null,
            userDisplayName: dto.userDisplayName ?? null,
            ipAddress: dto.ipAddress ?? null,
            remarks: dto.remarks ?? null,
            metadata: dto.metadata ?? null,
        });
        return this.auditRepository.save(event);
    }
    async getEntityHistory(entityType, entityId, limit = 50, offset = 0) {
        const [events, total] = await this.auditRepository.findAndCount({
            where: { entityType, entityId },
            order: { occurredAt: 'DESC' },
            take: limit,
            skip: offset,
        });
        return { events, total };
    }
    async getUserActivity(userId, limit = 50, offset = 0) {
        const [events, total] = await this.auditRepository.findAndCount({
            where: { userId },
            order: { occurredAt: 'DESC' },
            take: limit,
            skip: offset,
        });
        return { events, total };
    }
};
exports.AuditService = AuditService;
exports.AuditService = AuditService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(audit_event_entity_1.AuditEventEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], AuditService);
//# sourceMappingURL=audit.service.js.map