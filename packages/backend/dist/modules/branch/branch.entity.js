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
exports.BranchEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const client_entity_1 = require("../client/client.entity");
let BranchEntity = class BranchEntity extends base_entity_1.BaseEntity {
    branchCode;
    solId;
    name;
    address;
    state;
    district;
    city;
    pincode;
    region;
    territory;
    zoneId;
    branchType;
    phone;
    email;
    managerName;
    openingDate;
    lastAuditDate;
    operatingHours;
    latitude;
    longitude;
    location;
    organizationId;
    clientId;
    client;
    riskScore;
    riskCategory;
    complexity;
    estimatedDurationHours;
    requiredCompetencies;
    contacts;
    documents;
};
exports.BranchEntity = BranchEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'branch_code', length: 50 }),
    __metadata("design:type", String)
], BranchEntity.prototype, "branchCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'sol_id', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "solId", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 255 }),
    __metadata("design:type", String)
], BranchEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], BranchEntity.prototype, "address", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], BranchEntity.prototype, "state", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], BranchEntity.prototype, "district", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 100 }),
    __metadata("design:type", String)
], BranchEntity.prototype, "city", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "pincode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "region", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "territory", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'zone_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "zoneId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'branch_type', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "branchType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "phone", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "email", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'manager_name', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "managerName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'opening_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "openingDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'last_audit_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "lastAuditDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'operating_hours', type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "operatingHours", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'decimal', precision: 10, scale: 7, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "latitude", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'decimal', precision: 10, scale: 7, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "longitude", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'geometry',
        spatialFeatureType: 'Point',
        srid: 4326,
        nullable: true,
    }),
    (0, typeorm_1.Index)({ spatial: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "location", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'organization_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "organizationId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'client_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "clientId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => client_entity_1.ClientEntity, { onDelete: 'SET NULL' }),
    (0, typeorm_1.JoinColumn)({ name: 'client_id' }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "client", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'risk_score', type: 'decimal', precision: 5, scale: 2, default: 0.00 }),
    __metadata("design:type", Number)
], BranchEntity.prototype, "riskScore", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'risk_category', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "riskCategory", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 50, default: 'STANDARD' }),
    __metadata("design:type", String)
], BranchEntity.prototype, "complexity", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'estimated_duration_hours', type: 'decimal', precision: 5, scale: 2, default: 8.00 }),
    __metadata("design:type", Number)
], BranchEntity.prototype, "estimatedDurationHours", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'required_competencies', type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], BranchEntity.prototype, "requiredCompetencies", void 0);
__decorate([
    (0, typeorm_1.OneToMany)('BranchContactEntity', 'branch', { cascade: true }),
    __metadata("design:type", Array)
], BranchEntity.prototype, "contacts", void 0);
__decorate([
    (0, typeorm_1.OneToMany)('BranchDocumentEntity', 'branch', { cascade: true }),
    __metadata("design:type", Array)
], BranchEntity.prototype, "documents", void 0);
exports.BranchEntity = BranchEntity = __decorate([
    (0, typeorm_1.Entity)('branches'),
    (0, typeorm_1.Index)(['branchCode']),
    (0, typeorm_1.Index)(['solId']),
    (0, typeorm_1.Index)(['clientId']),
    (0, typeorm_1.Index)(['region']),
    (0, typeorm_1.Index)(['zoneId'])
], BranchEntity);
//# sourceMappingURL=branch.entity.js.map