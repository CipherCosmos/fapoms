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
exports.AssayerActivityEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assayer_entity_1 = require("./assayer.entity");
let AssayerActivityEntity = class AssayerActivityEntity extends base_entity_1.BaseEntity {
    assayerId;
    assayer;
    eventType;
    previousState;
    newState;
    performedBy;
    performedByName;
    remarks;
    metadata;
    occurredAt;
};
exports.AssayerActivityEntity = AssayerActivityEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerActivityEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], AssayerActivityEntity.prototype, "assayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'event_type', length: 100 }),
    __metadata("design:type", String)
], AssayerActivityEntity.prototype, "eventType", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'previous_state', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], AssayerActivityEntity.prototype, "previousState", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'new_state', type: 'varchar', length: 50, nullable: true }),
    __metadata("design:type", Object)
], AssayerActivityEntity.prototype, "newState", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'performed_by', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerActivityEntity.prototype, "performedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'performed_by_name', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], AssayerActivityEntity.prototype, "performedByName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssayerActivityEntity.prototype, "remarks", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], AssayerActivityEntity.prototype, "metadata", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'occurred_at', type: 'timestamptz', default: () => 'NOW()' }),
    __metadata("design:type", Date)
], AssayerActivityEntity.prototype, "occurredAt", void 0);
exports.AssayerActivityEntity = AssayerActivityEntity = __decorate([
    (0, typeorm_1.Entity)('assayer_activities'),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['occurredAt'])
], AssayerActivityEntity);
//# sourceMappingURL=assayer-activity.entity.js.map