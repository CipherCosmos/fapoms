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
exports.WorkforceAttributeEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assayer_entity_1 = require("./assayer.entity");
let WorkforceAttributeEntity = class WorkforceAttributeEntity extends base_entity_1.BaseEntity {
    assayerId;
    assayer;
    type;
    name;
    level;
    expiryDate;
    metadata;
};
exports.WorkforceAttributeEntity = WorkforceAttributeEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], WorkforceAttributeEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], WorkforceAttributeEntity.prototype, "assayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 50 }),
    __metadata("design:type", String)
], WorkforceAttributeEntity.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 150 }),
    __metadata("design:type", String)
], WorkforceAttributeEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], WorkforceAttributeEntity.prototype, "level", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'expiry_date', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], WorkforceAttributeEntity.prototype, "expiryDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], WorkforceAttributeEntity.prototype, "metadata", void 0);
exports.WorkforceAttributeEntity = WorkforceAttributeEntity = __decorate([
    (0, typeorm_1.Entity)('workforce_attributes'),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['type', 'name'])
], WorkforceAttributeEntity);
//# sourceMappingURL=workforce-attribute.entity.js.map