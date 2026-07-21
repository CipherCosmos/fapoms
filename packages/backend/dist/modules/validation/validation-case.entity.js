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
exports.ValidationCaseEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const shared_1 = require("@fapoms/shared");
let ValidationCaseEntity = class ValidationCaseEntity extends base_entity_1.BaseEntity {
    projectBranchId;
    status;
    ocrResult;
    reviewerId;
    reviewedAt;
    remarks;
    correctionNotes;
    projectBranch;
};
exports.ValidationCaseEntity = ValidationCaseEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'project_branch_id', type: 'uuid' }),
    __metadata("design:type", String)
], ValidationCaseEntity.prototype, "projectBranchId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.ValidationStatus,
        default: shared_1.ValidationStatus.PENDING,
    }),
    __metadata("design:type", String)
], ValidationCaseEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'ocr_result', type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], ValidationCaseEntity.prototype, "ocrResult", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'reviewer_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], ValidationCaseEntity.prototype, "reviewerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'reviewed_at', type: 'timestamp with time zone', nullable: true }),
    __metadata("design:type", Object)
], ValidationCaseEntity.prototype, "reviewedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ValidationCaseEntity.prototype, "remarks", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'correction_notes', type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ValidationCaseEntity.prototype, "correctionNotes", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => project_branch_entity_1.ProjectBranchEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'project_branch_id' }),
    __metadata("design:type", project_branch_entity_1.ProjectBranchEntity)
], ValidationCaseEntity.prototype, "projectBranch", void 0);
exports.ValidationCaseEntity = ValidationCaseEntity = __decorate([
    (0, typeorm_1.Entity)('validation_cases'),
    (0, typeorm_1.Index)(['projectBranchId']),
    (0, typeorm_1.Index)(['status'])
], ValidationCaseEntity);
//# sourceMappingURL=validation-case.entity.js.map