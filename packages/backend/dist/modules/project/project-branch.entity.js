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
exports.ProjectBranchEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const project_entity_1 = require("./project.entity");
const branch_entity_1 = require("../branch/branch.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const shared_1 = require("@fapoms/shared");
let ProjectBranchEntity = class ProjectBranchEntity extends base_entity_1.BaseEntity {
    projectId;
    branchId;
    status;
    priority;
    zoneId;
    scheduledDate;
    remarks;
    project;
    branch;
    assignment;
};
exports.ProjectBranchEntity = ProjectBranchEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'project_id', type: 'uuid' }),
    __metadata("design:type", String)
], ProjectBranchEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'branch_id', type: 'uuid' }),
    __metadata("design:type", String)
], ProjectBranchEntity.prototype, "branchId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.ProjectBranchStatus,
        default: shared_1.ProjectBranchStatus.IMPORTED,
    }),
    __metadata("design:type", String)
], ProjectBranchEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.Priority,
        default: shared_1.Priority.MEDIUM,
    }),
    __metadata("design:type", String)
], ProjectBranchEntity.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'zone_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], ProjectBranchEntity.prototype, "zoneId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'scheduled_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], ProjectBranchEntity.prototype, "scheduledDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ProjectBranchEntity.prototype, "remarks", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => project_entity_1.ProjectEntity, (p) => p.projectBranches, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'project_id' }),
    __metadata("design:type", project_entity_1.ProjectEntity)
], ProjectBranchEntity.prototype, "project", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => branch_entity_1.BranchEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'branch_id' }),
    __metadata("design:type", branch_entity_1.BranchEntity)
], ProjectBranchEntity.prototype, "branch", void 0);
__decorate([
    (0, typeorm_1.OneToOne)(() => assignment_entity_1.AssignmentEntity, (a) => a.projectBranch, { nullable: true }),
    __metadata("design:type", Object)
], ProjectBranchEntity.prototype, "assignment", void 0);
exports.ProjectBranchEntity = ProjectBranchEntity = __decorate([
    (0, typeorm_1.Entity)('project_branches'),
    (0, typeorm_1.Index)(['projectId']),
    (0, typeorm_1.Index)(['branchId']),
    (0, typeorm_1.Index)(['status'])
], ProjectBranchEntity);
//# sourceMappingURL=project-branch.entity.js.map