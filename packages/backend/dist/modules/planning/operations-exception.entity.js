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
exports.OperationsExceptionEntity = exports.OperationsExceptionStatus = exports.OperationsExceptionCategory = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
var OperationsExceptionCategory;
(function (OperationsExceptionCategory) {
    OperationsExceptionCategory["UNCOVERABLE_BRANCH"] = "UNCOVERABLE_BRANCH";
    OperationsExceptionCategory["CAPACITY_EXCEEDED"] = "CAPACITY_EXCEEDED";
    OperationsExceptionCategory["SCHEDULE_CONFLICT"] = "SCHEDULE_CONFLICT";
    OperationsExceptionCategory["COMMERCIAL_DISCREPANCY"] = "COMMERCIAL_DISCREPANCY";
    OperationsExceptionCategory["CERTIFICATION_EXPIRED"] = "CERTIFICATION_EXPIRED";
    OperationsExceptionCategory["ROUTE_UNREACHABLE"] = "ROUTE_UNREACHABLE";
})(OperationsExceptionCategory || (exports.OperationsExceptionCategory = OperationsExceptionCategory = {}));
var OperationsExceptionStatus;
(function (OperationsExceptionStatus) {
    OperationsExceptionStatus["UNRESOLVED"] = "UNRESOLVED";
    OperationsExceptionStatus["RESOLVED"] = "RESOLVED";
    OperationsExceptionStatus["BYPASSED"] = "BYPASSED";
})(OperationsExceptionStatus || (exports.OperationsExceptionStatus = OperationsExceptionStatus = {}));
let OperationsExceptionEntity = class OperationsExceptionEntity extends base_entity_1.BaseEntity {
    projectId;
    targetEntityId;
    category;
    status;
    message;
    overrideJustification;
};
exports.OperationsExceptionEntity = OperationsExceptionEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'project_id', type: 'uuid' }),
    __metadata("design:type", String)
], OperationsExceptionEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'target_entity_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], OperationsExceptionEntity.prototype, "targetEntityId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: OperationsExceptionCategory,
    }),
    __metadata("design:type", String)
], OperationsExceptionEntity.prototype, "category", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: OperationsExceptionStatus,
        default: OperationsExceptionStatus.UNRESOLVED,
    }),
    __metadata("design:type", String)
], OperationsExceptionEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], OperationsExceptionEntity.prototype, "message", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], OperationsExceptionEntity.prototype, "overrideJustification", void 0);
exports.OperationsExceptionEntity = OperationsExceptionEntity = __decorate([
    (0, typeorm_1.Entity)('operations_exceptions'),
    (0, typeorm_1.Index)(['projectId']),
    (0, typeorm_1.Index)(['status'])
], OperationsExceptionEntity);
//# sourceMappingURL=operations-exception.entity.js.map