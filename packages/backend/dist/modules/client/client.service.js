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
exports.ClientService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const client_entity_1 = require("./client.entity");
const client_configuration_entity_1 = require("./client-configuration.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let ClientService = class ClientService {
    clientRepository;
    configRepository;
    auditService;
    constructor(clientRepository, configRepository, auditService) {
        this.clientRepository = clientRepository;
        this.configRepository = configRepository;
        this.auditService = auditService;
    }
    async create(dto, userId) {
        const existing = await this.clientRepository.findOne({ where: { clientCode: dto.clientCode } });
        if (existing) {
            throw new common_1.ConflictException(`Client code ${dto.clientCode} already exists.`);
        }
        const config = this.configRepository.create({
            importMapping: dto.configuration?.importMapping ?? {},
            workingDays: dto.configuration?.workingDays ?? [1, 2, 3, 4, 5],
            defaultRadius: dto.configuration?.defaultRadius ?? 50.0,
            slaRules: dto.configuration?.slaRules ?? {},
            effectiveFrom: new Date(),
            createdBy: userId,
            updatedBy: userId,
        });
        const client = this.clientRepository.create({
            clientCode: dto.clientCode,
            name: dto.name,
            displayName: dto.displayName,
            contactPerson: dto.contactPerson ?? null,
            contactEmail: dto.contactEmail ?? null,
            contactPhone: dto.contactPhone ?? null,
            address: dto.address ?? null,
            createdBy: userId,
            updatedBy: userId,
            configuration: config,
        });
        const saved = await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_CREATED',
            entityType: 'CLIENT',
            entityId: saved.id,
            userId,
            remarks: `Created client ${saved.name} (${saved.clientCode})`,
        });
        return saved;
    }
    async findOne(id) {
        const client = await this.clientRepository.findOne({
            where: { id, isActive: true },
            relations: ['configuration'],
        });
        if (!client) {
            throw new common_1.NotFoundException(`Client ${id} not found.`);
        }
        return client;
    }
    async findAll(page = 1, limit = 20) {
        const [clients, total] = await this.clientRepository.findAndCount({
            where: { isActive: true },
            relations: ['configuration'],
            take: limit,
            skip: (page - 1) * limit,
            order: { name: 'ASC' },
        });
        return { clients, total };
    }
    async update(id, dto, userId) {
        const client = await this.findOne(id);
        if (dto.name !== undefined)
            client.name = dto.name;
        if (dto.displayName !== undefined)
            client.displayName = dto.displayName;
        if (dto.contactPerson !== undefined)
            client.contactPerson = dto.contactPerson;
        if (dto.contactEmail !== undefined)
            client.contactEmail = dto.contactEmail;
        if (dto.contactPhone !== undefined)
            client.contactPhone = dto.contactPhone;
        if (dto.address !== undefined)
            client.address = dto.address;
        if (dto.configuration && client.configuration) {
            const conf = client.configuration;
            if (dto.configuration.importMapping !== undefined)
                conf.importMapping = dto.configuration.importMapping;
            if (dto.configuration.workingDays !== undefined)
                conf.workingDays = dto.configuration.workingDays;
            if (dto.configuration.defaultRadius !== undefined)
                conf.defaultRadius = dto.configuration.defaultRadius;
            if (dto.configuration.slaRules !== undefined)
                conf.slaRules = dto.configuration.slaRules;
            if (dto.configuration.effectiveTo !== undefined)
                conf.effectiveTo = dto.configuration.effectiveTo;
            conf.updatedBy = userId;
        }
        client.updatedBy = userId;
        const saved = await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_UPDATED',
            entityType: 'CLIENT',
            entityId: id,
            userId,
            remarks: `Updated client ${client.name}`,
        });
        return saved;
    }
    async remove(id, userId) {
        const client = await this.findOne(id);
        client.isActive = false;
        client.updatedBy = userId;
        await this.clientRepository.save(client);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.OPERATIONAL,
            eventType: 'CLIENT_DELETED',
            entityType: 'CLIENT',
            entityId: id,
            userId,
            remarks: `Soft deleted client ${client.name}`,
        });
    }
};
exports.ClientService = ClientService;
exports.ClientService = ClientService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(client_configuration_entity_1.ClientConfigurationEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], ClientService);
//# sourceMappingURL=client.service.js.map