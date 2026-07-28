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
exports.CoveragePlanVersionEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const coverage_plan_entity_1 = require("./coverage-plan.entity");
let CoveragePlanVersionEntity = class CoveragePlanVersionEntity extends base_entity_1.BaseEntity {
    coveragePlanId;
    versionNumber;
    planData;
    overrides;
    changeJustification;
    coveragePlan;
};
exports.CoveragePlanVersionEntity = CoveragePlanVersionEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'coverage_plan_id', type: 'uuid' }),
    __metadata("design:type", String)
], CoveragePlanVersionEntity.prototype, "coveragePlanId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer' }),
    __metadata("design:type", Number)
], CoveragePlanVersionEntity.prototype, "versionNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb' }),
    __metadata("design:type", Object)
], CoveragePlanVersionEntity.prototype, "planData", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], CoveragePlanVersionEntity.prototype, "overrides", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], CoveragePlanVersionEntity.prototype, "changeJustification", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => coverage_plan_entity_1.CoveragePlanEntity, (cp) => cp.versions, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'coverage_plan_id' }),
    __metadata("design:type", coverage_plan_entity_1.CoveragePlanEntity)
], CoveragePlanVersionEntity.prototype, "coveragePlan", void 0);
exports.CoveragePlanVersionEntity = CoveragePlanVersionEntity = __decorate([
    (0, typeorm_1.Entity)('coverage_plan_versions'),
    (0, typeorm_1.Index)(['coveragePlanId'])
], CoveragePlanVersionEntity);
//# sourceMappingURL=coverage-plan-version.entity.js.map