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
exports.CapabilityEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const permission_entity_1 = require("./permission.entity");
let CapabilityEntity = class CapabilityEntity extends base_entity_1.BaseEntity {
    name;
    displayName;
    description;
    category;
    permissions;
};
exports.CapabilityEntity = CapabilityEntity;
__decorate([
    (0, typeorm_1.Column)({ unique: true, length: 100 }),
    __metadata("design:type", String)
], CapabilityEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'display_name', length: 100 }),
    __metadata("design:type", String)
], CapabilityEntity.prototype, "displayName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", String)
], CapabilityEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 50, nullable: true, comment: 'Logical grouping, e.g. PROJECT, ASSIGNMENT' }),
    __metadata("design:type", String)
], CapabilityEntity.prototype, "category", void 0);
__decorate([
    (0, typeorm_1.ManyToMany)(() => permission_entity_1.PermissionEntity, { eager: true }),
    (0, typeorm_1.JoinTable)({
        name: 'capability_permissions',
        joinColumn: { name: 'capability_id' },
        inverseJoinColumn: { name: 'permission_id' },
    }),
    __metadata("design:type", Array)
], CapabilityEntity.prototype, "permissions", void 0);
exports.CapabilityEntity = CapabilityEntity = __decorate([
    (0, typeorm_1.Entity)('capabilities')
], CapabilityEntity);
//# sourceMappingURL=capability.entity.js.map