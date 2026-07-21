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
exports.CommunicationEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const shared_1 = require("@fapoms/shared");
let CommunicationEntity = class CommunicationEntity extends base_entity_1.BaseEntity {
    assignmentId;
    type;
    content;
    initiatedBy;
    recipientRef;
    isDelivered;
    assignment;
};
exports.CommunicationEntity = CommunicationEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assignment_id', type: 'uuid' }),
    __metadata("design:type", String)
], CommunicationEntity.prototype, "assignmentId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.CommunicationType,
    }),
    __metadata("design:type", String)
], CommunicationEntity.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], CommunicationEntity.prototype, "content", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'initiated_by', type: 'uuid' }),
    __metadata("design:type", String)
], CommunicationEntity.prototype, "initiatedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'recipient_ref', type: 'varchar', length: 150, nullable: true }),
    __metadata("design:type", Object)
], CommunicationEntity.prototype, "recipientRef", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'is_delivered', type: 'boolean', default: true }),
    __metadata("design:type", Boolean)
], CommunicationEntity.prototype, "isDelivered", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assignment_entity_1.AssignmentEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assignment_id' }),
    __metadata("design:type", assignment_entity_1.AssignmentEntity)
], CommunicationEntity.prototype, "assignment", void 0);
exports.CommunicationEntity = CommunicationEntity = __decorate([
    (0, typeorm_1.Entity)('communications'),
    (0, typeorm_1.Index)(['assignmentId']),
    (0, typeorm_1.Index)(['type'])
], CommunicationEntity);
//# sourceMappingURL=communication.entity.js.map