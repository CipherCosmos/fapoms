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
exports.OperationsTaskEntity = exports.OperationsTaskStatus = exports.OperationsTaskPriority = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
var OperationsTaskPriority;
(function (OperationsTaskPriority) {
    OperationsTaskPriority["LOW"] = "LOW";
    OperationsTaskPriority["MEDIUM"] = "MEDIUM";
    OperationsTaskPriority["HIGH"] = "HIGH";
    OperationsTaskPriority["CRITICAL"] = "CRITICAL";
})(OperationsTaskPriority || (exports.OperationsTaskPriority = OperationsTaskPriority = {}));
var OperationsTaskStatus;
(function (OperationsTaskStatus) {
    OperationsTaskStatus["OPEN"] = "OPEN";
    OperationsTaskStatus["IN_PROGRESS"] = "IN_PROGRESS";
    OperationsTaskStatus["RESOLVED"] = "RESOLVED";
    OperationsTaskStatus["DISMISSED"] = "DISMISSED";
})(OperationsTaskStatus || (exports.OperationsTaskStatus = OperationsTaskStatus = {}));
let OperationsTaskEntity = class OperationsTaskEntity extends base_entity_1.BaseEntity {
    projectId;
    title;
    reason;
    priority;
    status;
    dueTime;
    ownerId;
    resolutionJustification;
};
exports.OperationsTaskEntity = OperationsTaskEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'project_id', type: 'uuid' }),
    __metadata("design:type", String)
], OperationsTaskEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], OperationsTaskEntity.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], OperationsTaskEntity.prototype, "reason", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: OperationsTaskPriority,
        default: OperationsTaskPriority.MEDIUM,
    }),
    __metadata("design:type", String)
], OperationsTaskEntity.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: OperationsTaskStatus,
        default: OperationsTaskStatus.OPEN,
    }),
    __metadata("design:type", String)
], OperationsTaskEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'due_time', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], OperationsTaskEntity.prototype, "dueTime", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'owner_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], OperationsTaskEntity.prototype, "ownerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], OperationsTaskEntity.prototype, "resolutionJustification", void 0);
exports.OperationsTaskEntity = OperationsTaskEntity = __decorate([
    (0, typeorm_1.Entity)('operations_tasks'),
    (0, typeorm_1.Index)(['projectId']),
    (0, typeorm_1.Index)(['status'])
], OperationsTaskEntity);
//# sourceMappingURL=operations-task.entity.js.map