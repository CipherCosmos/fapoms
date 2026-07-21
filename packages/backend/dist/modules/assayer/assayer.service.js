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
exports.AssayerService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const assayer_entity_1 = require("./assayer.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
const assayer_commercial_profile_entity_1 = require("./assayer-commercial-profile.entity");
const workforce_attribute_entity_1 = require("./workforce-attribute.entity");
const typeorm_3 = require("typeorm");
let AssayerService = class AssayerService {
    assayerRepository;
    commercialRepository;
    workforceAttributeRepository;
    auditService;
    constructor(assayerRepository, commercialRepository, workforceAttributeRepository, auditService) {
        this.assayerRepository = assayerRepository;
        this.commercialRepository = commercialRepository;
        this.workforceAttributeRepository = workforceAttributeRepository;
        this.auditService = auditService;
    }
    async findAll(page = 1, limit = 50) {
        const [assayers, total] = await this.assayerRepository.findAndCount({
            where: { isActive: true },
            skip: (page - 1) * limit,
            take: limit,
            order: { createdAt: 'DESC' },
        });
        return { assayers, total };
    }
    async findOne(id) {
        const assayer = await this.assayerRepository.findOne({
            where: { id, isActive: true },
        });
        if (!assayer) {
            throw new common_1.NotFoundException(`Assayer ${id} not found.`);
        }
        return assayer;
    }
    async create(dto, userId) {
        const existing = await this.assayerRepository.findOne({
            where: { assayerCode: dto.assayerCode },
        });
        if (existing) {
            throw new common_1.ConflictException(`Assayer code ${dto.assayerCode} already exists.`);
        }
        let location = null;
        if (dto.latitude && dto.longitude) {
            location = {
                type: 'Point',
                coordinates: [dto.longitude, dto.latitude],
            };
        }
        const assayer = this.assayerRepository.create({
            ...dto,
            displayName: `${dto.firstName} ${dto.lastName}`,
            location,
            status: shared_1.AssayerStatus.REGISTERED,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.assayerRepository.save(assayer);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_CREATED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Created assayer profile: ${saved.displayName} (${saved.assayerCode})`,
        });
        return saved;
    }
    async update(id, dto, userId) {
        const assayer = await this.findOne(id);
        Object.keys(dto).forEach((key) => {
            if (dto[key] !== undefined) {
                assayer[key] = dto[key];
            }
        });
        if (dto.firstName || dto.lastName) {
            assayer.displayName = `${dto.firstName ?? assayer.firstName} ${dto.lastName ?? assayer.lastName}`;
        }
        if (dto.latitude && dto.longitude) {
            assayer.location = {
                type: 'Point',
                coordinates: [dto.longitude, dto.latitude],
            };
        }
        assayer.updatedBy = userId;
        const saved = await this.assayerRepository.save(assayer);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_UPDATED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Updated assayer profile: ${saved.displayName}`,
        });
        return saved;
    }
    async remove(id, userId) {
        const assayer = await this.findOne(id);
        assayer.isActive = false;
        assayer.updatedBy = userId;
        await this.assayerRepository.save(assayer);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_DELETED',
            entityType: 'ASSAYER',
            entityId: id,
            userId,
            remarks: `Soft deleted assayer profile ${assayer.displayName}`,
        });
    }
    async createCommercialProfile(assayerId, dto, userId) {
        await this.findOne(assayerId);
        const profile = this.commercialRepository.create({
            ...dto,
            assayerId,
            effectiveStartDate: new Date(dto.effectiveStartDate),
            effectiveEndDate: dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.commercialRepository.save(profile);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_COMMERCIAL_PROFILE_CREATED',
            entityType: 'ASSAYER_COMMERCIAL_PROFILE',
            entityId: saved.id,
            userId,
            remarks: `Created commercial profile for assayer ${assayerId} with base fee ₹${dto.baseFee}`,
        });
        return saved;
    }
    async updateCommercialProfile(profileId, dto, userId) {
        const profile = await this.commercialRepository.findOne({
            where: { id: profileId, isActive: true },
        });
        if (!profile) {
            throw new common_1.NotFoundException(`Commercial profile ${profileId} not found.`);
        }
        if (dto.baseFee !== undefined)
            profile.baseFee = dto.baseFee;
        if (dto.hourlyRate !== undefined)
            profile.hourlyRate = dto.hourlyRate;
        if (dto.dailyRate !== undefined)
            profile.dailyRate = dto.dailyRate;
        if (dto.travelReimbursement !== undefined)
            profile.travelReimbursement = dto.travelReimbursement;
        if (dto.accommodationAllowance !== undefined)
            profile.accommodationAllowance = dto.accommodationAllowance;
        if (dto.mealAllowance !== undefined)
            profile.mealAllowance = dto.mealAllowance;
        if (dto.currency !== undefined)
            profile.currency = dto.currency;
        if (dto.effectiveStartDate !== undefined)
            profile.effectiveStartDate = new Date(dto.effectiveStartDate);
        if (dto.effectiveEndDate !== undefined) {
            profile.effectiveEndDate = dto.effectiveEndDate ? new Date(dto.effectiveEndDate) : null;
        }
        profile.updatedBy = userId;
        const saved = await this.commercialRepository.save(profile);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ASSAYER_COMMERCIAL_PROFILE_UPDATED',
            entityType: 'ASSAYER_COMMERCIAL_PROFILE',
            entityId: saved.id,
            userId,
            remarks: `Updated commercial profile ${profileId}`,
        });
        return saved;
    }
    async getCommercialProfiles(assayerId) {
        return this.commercialRepository.find({
            where: { assayerId, isActive: true },
            order: { effectiveStartDate: 'DESC' },
        });
    }
    async getActiveCommercialProfile(assayerId, date = new Date()) {
        const profiles = await this.commercialRepository.find({
            where: {
                assayerId,
                isActive: true,
                effectiveStartDate: (0, typeorm_3.LessThanOrEqual)(date),
            },
            order: { effectiveStartDate: 'DESC' },
        });
        for (const p of profiles) {
            if (!p.effectiveEndDate || p.effectiveEndDate >= date) {
                return p;
            }
        }
        return null;
    }
    async addWorkforceAttribute(assayerId, dto, userId) {
        await this.findOne(assayerId);
        const attr = this.workforceAttributeRepository.create({
            ...dto,
            assayerId,
            expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.workforceAttributeRepository.save(attr);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFORCE_ATTRIBUTE_CREATED',
            entityType: 'WORKFORCE_ATTRIBUTE',
            entityId: saved.id,
            userId,
            remarks: `Added ${dto.type} '${dto.name}' to assayer ${assayerId}`,
        });
        return saved;
    }
    async updateWorkforceAttribute(attributeId, dto, userId) {
        const attr = await this.workforceAttributeRepository.findOne({
            where: { id: attributeId, isActive: true },
        });
        if (!attr) {
            throw new common_1.NotFoundException(`Workforce attribute ${attributeId} not found.`);
        }
        if (dto.name !== undefined)
            attr.name = dto.name;
        if (dto.level !== undefined)
            attr.level = dto.level;
        if (dto.expiryDate !== undefined)
            attr.expiryDate = dto.expiryDate ? new Date(dto.expiryDate) : null;
        if (dto.metadata !== undefined)
            attr.metadata = dto.metadata;
        attr.updatedBy = userId;
        const saved = await this.workforceAttributeRepository.save(attr);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFORCE_ATTRIBUTE_UPDATED',
            entityType: 'WORKFORCE_ATTRIBUTE',
            entityId: saved.id,
            userId,
            remarks: `Updated workforce attribute ${attributeId}`,
        });
        return saved;
    }
    async removeWorkforceAttribute(attributeId, userId) {
        const attr = await this.workforceAttributeRepository.findOne({
            where: { id: attributeId, isActive: true },
        });
        if (!attr) {
            throw new common_1.NotFoundException(`Workforce attribute ${attributeId} not found.`);
        }
        attr.isActive = false;
        attr.updatedBy = userId;
        await this.workforceAttributeRepository.save(attr);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'WORKFORCE_ATTRIBUTE_DELETED',
            entityType: 'WORKFORCE_ATTRIBUTE',
            entityId: attributeId,
            userId,
            remarks: `Removed workforce attribute '${attr.name}' from assayer ${attr.assayerId}`,
        });
    }
    async getWorkforceAttributes(assayerId, type) {
        const where = { assayerId, isActive: true };
        if (type)
            where.type = type;
        return this.workforceAttributeRepository.find({
            where,
            order: { type: 'ASC', name: 'ASC' },
        });
    }
};
exports.AssayerService = AssayerService;
exports.AssayerService = AssayerService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(workforce_attribute_entity_1.WorkforceAttributeEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], AssayerService);
//# sourceMappingURL=assayer.service.js.map