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
exports.OrganizationEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let OrganizationEntity = class OrganizationEntity extends base_entity_1.BaseEntity {
    name;
    code;
    displayName;
    description;
    address;
    contactEmail;
    contactPhone;
    taxId;
    registrationNumber;
};
exports.OrganizationEntity = OrganizationEntity;
__decorate([
    (0, typeorm_1.Column)({ length: 200 }),
    __metadata("design:type", String)
], OrganizationEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ unique: true, length: 50 }),
    __metadata("design:type", String)
], OrganizationEntity.prototype, "code", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'display_name', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "displayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "address", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'contact_email', type: 'varchar', length: 150, nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "contactEmail", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'contact_phone', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "contactPhone", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'tax_id', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "taxId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'registration_number', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], OrganizationEntity.prototype, "registrationNumber", void 0);
exports.OrganizationEntity = OrganizationEntity = __decorate([
    (0, typeorm_1.Entity)('organizations')
], OrganizationEntity);
//# sourceMappingURL=organization.entity.js.map