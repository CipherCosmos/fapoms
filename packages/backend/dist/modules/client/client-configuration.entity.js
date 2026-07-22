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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientConfigurationEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let ClientConfigurationEntity = class ClientConfigurationEntity extends base_entity_1.BaseEntity {
    clientId;
    client;
    importMapping;
    workingDays;
    defaultRadius;
    slaRules;
    serviceLevel;
    maxResponseTimeHours;
    penaltyRate;
    serviceHours;
    effectiveFrom;
    effectiveTo;
};
exports.ClientConfigurationEntity = ClientConfigurationEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'client_id', type: 'uuid' }),
    __metadata("design:type", String)
], ClientConfigurationEntity.prototype, "clientId", void 0);
__decorate([
    (0, typeorm_1.OneToOne)('ClientEntity', 'configuration', { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'client_id' }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "client", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'import_mapping',
        type: 'jsonb',
        nullable: true,
        comment: 'Custom mapping of Excel columns to FAPOMS schema fields',
    }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "importMapping", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'working_days',
        type: 'jsonb',
        nullable: true,
        comment: 'List of working days (0=Sunday, 1=Monday, ..., 6=Saturday)',
    }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "workingDays", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'default_radius',
        type: 'decimal',
        precision: 5,
        scale: 2,
        default: 50.00,
        comment: 'Default assignment search radius in kilometers',
    }),
    __metadata("design:type", Number)
], ClientConfigurationEntity.prototype, "defaultRadius", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'sla_rules',
        type: 'jsonb',
        nullable: true,
        comment: 'SLA parameters such as maximum response time, scheduling windows',
    }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "slaRules", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'service_level', type: 'varchar', length: 50, nullable: true, comment: 'SLA tier: PREMIUM, STANDARD, BASIC' }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "serviceLevel", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'max_response_time_hours', type: 'int', nullable: true, comment: 'Maximum response time in hours' }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "maxResponseTimeHours", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'penalty_rate', type: 'decimal', precision: 5, scale: 2, nullable: true, comment: 'Penalty rate for SLA breaches (%)' }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "penaltyRate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'service_hours', type: 'jsonb', nullable: true, comment: 'Service hours configuration' }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "serviceHours", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'effective_from', type: 'timestamptz' }),
    __metadata("design:type", Date)
], ClientConfigurationEntity.prototype, "effectiveFrom", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'effective_to', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], ClientConfigurationEntity.prototype, "effectiveTo", void 0);
exports.ClientConfigurationEntity = ClientConfigurationEntity = __decorate([
    (0, typeorm_1.Entity)('client_configurations')
], ClientConfigurationEntity);
//# sourceMappingURL=client-configuration.entity.js.map