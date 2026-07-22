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
exports.OrganizationService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const organization_entity_1 = require("./organization.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let OrganizationService = class OrganizationService {
    organizationRepository;
    auditService;
    constructor(organizationRepository, auditService) {
        this.organizationRepository = organizationRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const existing = await this.organizationRepository.findOne({
            where: { code: dto.code },
        });
        if (existing) {
            throw new common_1.ConflictException(`Organization code ${dto.code} already exists.`);
        }
        const org = this.organizationRepository.create({
            ...dto,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.organizationRepository.save(org);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ORGANIZATION_CREATED',
            entityType: 'ORGANIZATION',
            entityId: saved.id,
            userId,
            remarks: `Created organization: ${saved.name} (${saved.code})`,
        });
        return saved;
    }
    async findAll(page = 1, limit = 50) {
        const [organizations, total] = await this.organizationRepository.findAndCount({
            where: { isActive: true },
            skip: (page - 1) * limit,
            take: limit,
            order: { createdAt: 'DESC' },
        });
        return { organizations, total };
    }
    async findOne(id) {
        const org = await this.organizationRepository.findOne({
            where: { id, isActive: true },
        });
        if (!org) {
            throw new common_1.NotFoundException(`Organization ${id} not found.`);
        }
        return org;
    }
    async update(id, dto, userId) {
        const org = await this.findOne(id);
        Object.assign(org, dto);
        org.updatedBy = userId;
        const saved = await this.organizationRepository.save(org);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ORGANIZATION_UPDATED',
            entityType: 'ORGANIZATION',
            entityId: id,
            userId,
            remarks: `Updated organization: ${org.name}`,
        });
        return saved;
    }
    async remove(id, userId) {
        const org = await this.findOne(id);
        org.isActive = false;
        org.updatedBy = userId;
        await this.organizationRepository.save(org);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ORGANIZATION_DELETED',
            entityType: 'ORGANIZATION',
            entityId: id,
            userId,
            remarks: `Soft deleted organization: ${org.name}`,
        });
    }
};
exports.OrganizationService = OrganizationService;
exports.OrganizationService = OrganizationService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(organization_entity_1.OrganizationEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        audit_service_1.AuditService])
], OrganizationService);
//# sourceMappingURL=organization.service.js.map