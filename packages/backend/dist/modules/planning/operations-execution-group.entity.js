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
exports.OperationsExecutionGroupEntity = exports.ExecutionGroupStatus = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
var ExecutionGroupStatus;
(function (ExecutionGroupStatus) {
    ExecutionGroupStatus["DRAFT"] = "DRAFT";
    ExecutionGroupStatus["DISPATCHED"] = "DISPATCHED";
    ExecutionGroupStatus["ACCEPTED"] = "ACCEPTED";
    ExecutionGroupStatus["DECLINED"] = "DECLINED";
    ExecutionGroupStatus["CONFIRMED"] = "CONFIRMED";
    ExecutionGroupStatus["READY"] = "READY";
    ExecutionGroupStatus["COMPLETED"] = "COMPLETED";
    ExecutionGroupStatus["CANCELLED"] = "CANCELLED";
})(ExecutionGroupStatus || (exports.ExecutionGroupStatus = ExecutionGroupStatus = {}));
let OperationsExecutionGroupEntity = class OperationsExecutionGroupEntity extends base_entity_1.BaseEntity {
    assayerId;
    name;
    status;
    totalFee;
    logisticsPreferences;
    assignments;
};
exports.OperationsExecutionGroupEntity = OperationsExecutionGroupEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], OperationsExecutionGroupEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], OperationsExecutionGroupEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: ExecutionGroupStatus,
        default: ExecutionGroupStatus.DRAFT,
    }),
    __metadata("design:type", String)
], OperationsExecutionGroupEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'total_fee', type: 'numeric', precision: 10, scale: 2, default: 0 }),
    __metadata("design:type", Number)
], OperationsExecutionGroupEntity.prototype, "totalFee", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], OperationsExecutionGroupEntity.prototype, "logisticsPreferences", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => assignment_entity_1.AssignmentEntity, (a) => a.executionGroup),
    __metadata("design:type", Array)
], OperationsExecutionGroupEntity.prototype, "assignments", void 0);
exports.OperationsExecutionGroupEntity = OperationsExecutionGroupEntity = __decorate([
    (0, typeorm_1.Entity)('operations_execution_groups'),
    (0, typeorm_1.Index)(['assayerId'])
], OperationsExecutionGroupEntity);
//# sourceMappingURL=operations-execution-group.entity.js.map