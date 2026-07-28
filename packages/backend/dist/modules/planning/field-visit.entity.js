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
exports.FieldVisitEntity = exports.FieldVisitStatus = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
var FieldVisitStatus;
(function (FieldVisitStatus) {
    FieldVisitStatus["READY"] = "READY";
    FieldVisitStatus["DISPATCHED"] = "DISPATCHED";
    FieldVisitStatus["TRAVELLING"] = "TRAVELLING";
    FieldVisitStatus["ARRIVED"] = "ARRIVED";
    FieldVisitStatus["AUDIT_STARTED"] = "AUDIT_STARTED";
    FieldVisitStatus["EVIDENCE_COLLECTION"] = "EVIDENCE_COLLECTION";
    FieldVisitStatus["AUDIT_COMPLETED"] = "AUDIT_COMPLETED";
    FieldVisitStatus["DELIVERABLE_PREPARATION"] = "DELIVERABLE_PREPARATION";
    FieldVisitStatus["SUBMITTED"] = "SUBMITTED";
    FieldVisitStatus["HANDOVER_READY"] = "HANDOVER_READY";
})(FieldVisitStatus || (exports.FieldVisitStatus = FieldVisitStatus = {}));
let FieldVisitEntity = class FieldVisitEntity extends base_entity_1.BaseEntity {
    coveragePlanId;
    executionGroupId;
    branchId;
    assayerId;
    plannedDate;
    status;
    actualStartTime;
    actualEndTime;
    evidenceReadiness;
    completionSummary;
};
exports.FieldVisitEntity = FieldVisitEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'coverage_plan_id', type: 'uuid' }),
    __metadata("design:type", String)
], FieldVisitEntity.prototype, "coveragePlanId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'execution_group_id', type: 'uuid' }),
    __metadata("design:type", String)
], FieldVisitEntity.prototype, "executionGroupId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'branch_id', type: 'uuid' }),
    __metadata("design:type", String)
], FieldVisitEntity.prototype, "branchId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], FieldVisitEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'planned_date', type: 'date' }),
    __metadata("design:type", String)
], FieldVisitEntity.prototype, "plannedDate", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: FieldVisitStatus,
        default: FieldVisitStatus.READY,
    }),
    __metadata("design:type", String)
], FieldVisitEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'actual_start_time', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], FieldVisitEntity.prototype, "actualStartTime", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'actual_end_time', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], FieldVisitEntity.prototype, "actualEndTime", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], FieldVisitEntity.prototype, "evidenceReadiness", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], FieldVisitEntity.prototype, "completionSummary", void 0);
exports.FieldVisitEntity = FieldVisitEntity = __decorate([
    (0, typeorm_1.Entity)('operations_field_visits'),
    (0, typeorm_1.Index)(['branchId']),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['status'])
], FieldVisitEntity);
//# sourceMappingURL=field-visit.entity.js.map