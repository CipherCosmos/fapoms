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
exports.AssignmentEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const project_entity_1 = require("../project/project.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const shared_1 = require("@fapoms/shared");
let AssignmentEntity = class AssignmentEntity extends base_entity_1.BaseEntity {
    assignmentNumber;
    projectBranchId;
    projectId;
    assayerId;
    status;
    priority;
    proposedFee;
    agreedFee;
    scheduledDate;
    completionDate;
    remarks;
    slaDueDate;
    slaStatus;
    cancelReason;
    rejectReason;
    projectBranch;
    project;
    assayer;
};
exports.AssignmentEntity = AssignmentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assignment_number', length: 50, unique: true }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "assignmentNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'project_branch_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "projectBranchId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'project_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.AssignmentStatus,
        default: shared_1.AssignmentStatus.CREATED,
    }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.Priority,
        default: shared_1.Priority.MEDIUM,
    }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'proposed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "proposedFee", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'agreed_fee', type: 'decimal', precision: 12, scale: 2, nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "agreedFee", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'scheduled_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "scheduledDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'completion_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "completionDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "remarks", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'sla_due_date', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "slaDueDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'sla_status', type: 'varchar', length: 50, default: 'COMPLIANT' }),
    __metadata("design:type", String)
], AssignmentEntity.prototype, "slaStatus", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'cancel_reason', type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "cancelReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'reject_reason', type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssignmentEntity.prototype, "rejectReason", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => project_branch_entity_1.ProjectBranchEntity, (pb) => pb.assignments, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'project_branch_id' }),
    __metadata("design:type", project_branch_entity_1.ProjectBranchEntity)
], AssignmentEntity.prototype, "projectBranch", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => project_entity_1.ProjectEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'project_id' }),
    __metadata("design:type", project_entity_1.ProjectEntity)
], AssignmentEntity.prototype, "project", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], AssignmentEntity.prototype, "assayer", void 0);
exports.AssignmentEntity = AssignmentEntity = __decorate([
    (0, typeorm_1.Entity)('assignments'),
    (0, typeorm_1.Index)(['assignmentNumber']),
    (0, typeorm_1.Index)(['projectBranchId']),
    (0, typeorm_1.Index)(['projectId']),
    (0, typeorm_1.Index)(['assayerId'])
], AssignmentEntity);
//# sourceMappingURL=assignment.entity.js.map