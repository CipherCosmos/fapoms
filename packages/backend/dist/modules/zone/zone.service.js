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
exports.ZoneService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const zone_entity_1 = require("./zone.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let ZoneService = class ZoneService {
    zoneRepository;
    auditService;
    constructor(zoneRepository, auditService) {
        this.zoneRepository = zoneRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const zone = this.zoneRepository.create({
            name: dto.name,
            description: dto.description ?? null,
            clientId: dto.clientId ?? null,
            states: dto.states ?? [],
            districts: dto.districts ?? [],
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.zoneRepository.save(zone);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ZONE_CREATED',
            entityType: 'ZONE',
            entityId: saved.id,
            userId,
            remarks: `Created operational zone ${saved.name}`,
        });
        return saved;
    }
    async findOne(id) {
        const zone = await this.zoneRepository.findOne({ where: { id, isActive: true } });
        if (!zone) {
            throw new common_1.NotFoundException(`Zone ${id} not found.`);
        }
        return zone;
    }
    async findAll(page = 1, limit = 20, clientId) {
        const query = this.zoneRepository.createQueryBuilder('zone')
            .where('zone.is_active = :isActive', { isActive: true });
        if (clientId) {
            query.andWhere('zone.client_id = :clientId', { clientId });
        }
        const [zones, total] = await query
            .orderBy('zone.name', 'ASC')
            .take(limit)
            .skip((page - 1) * limit)
            .getManyAndCount();
        return { zones, total };
    }
    async update(id, dto, userId) {
        const zone = await this.findOne(id);
        if (dto.name !== undefined)
            zone.name = dto.name;
        if (dto.description !== undefined)
            zone.description = dto.description;
        if (dto.states !== undefined)
            zone.states = dto.states;
        if (dto.districts !== undefined)
            zone.districts = dto.districts;
        zone.updatedBy = userId;
        const saved = await this.zoneRepository.save(zone);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ZONE_UPDATED',
            entityType: 'ZONE',
            entityId: id,
            userId,
            remarks: `Updated operational zone ${zone.name}`,
        });
        return saved;
    }
    async remove(id, userId) {
        const zone = await this.findOne(id);
        zone.isActive = false;
        zone.updatedBy = userId;
        await this.zoneRepository.save(zone);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'ZONE_DELETED',
            entityType: 'ZONE',
            entityId: id,
            userId,
            remarks: `Soft deleted operational zone ${zone.name}`,
        });
    }
};
exports.ZoneService = ZoneService;
exports.ZoneService = ZoneService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(zone_entity_1.ZoneEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        audit_service_1.AuditService])
], ZoneService);
//# sourceMappingURL=zone.service.js.map