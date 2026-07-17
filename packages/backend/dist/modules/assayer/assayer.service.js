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
let AssayerService = class AssayerService {
    assayerRepository;
    auditService;
    constructor(assayerRepository, auditService) {
        this.assayerRepository = assayerRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const existing = await this.assayerRepository.findOne({ where: { assayerCode: dto.assayerCode } });
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
            eventType: 'ASSAYER_REGISTERED',
            entityType: 'ASSAYER',
            entityId: saved.id,
            userId,
            remarks: `Registered assayer ${saved.displayName} (${saved.assayerCode})`,
        });
        return saved;
    }
    async findOne(id) {
        const assayer = await this.assayerRepository.findOne({ where: { id, isActive: true } });
        if (!assayer) {
            throw new common_1.NotFoundException(`Assayer ${id} not found.`);
        }
        return assayer;
    }
    async findAll(page = 1, limit = 20) {
        const [assayers, total] = await this.assayerRepository.findAndCount({
            where: { isActive: true },
            take: limit,
            skip: (page - 1) * limit,
            order: { displayName: 'ASC' },
        });
        return { assayers, total };
    }
    async update(id, dto, userId) {
        const assayer = await this.findOne(id);
        const prevStatus = assayer.status;
        Object.assign(assayer, dto);
        if (dto.firstName || dto.lastName) {
            assayer.displayName = `${assayer.firstName} ${assayer.lastName}`;
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
            entityId: id,
            previousState: prevStatus,
            newState: saved.status,
            userId,
            remarks: `Updated assayer profile ${assayer.displayName}`,
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
};
exports.AssayerService = AssayerService;
exports.AssayerService = AssayerService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        audit_service_1.AuditService])
], AssayerService);
//# sourceMappingURL=assayer.service.js.map