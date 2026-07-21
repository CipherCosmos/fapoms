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
exports.ScheduleEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const project_entity_1 = require("../project/project.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const shared_1 = require("@fapoms/shared");
let ScheduleEntity = class ScheduleEntity extends base_entity_1.BaseEntity {
    assignmentId;
    projectId;
    assayerId;
    scheduledDate;
    status;
    remarks;
    assignment;
    project;
    assayer;
};
exports.ScheduleEntity = ScheduleEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assignment_id', type: 'uuid' }),
    __metadata("design:type", String)
], ScheduleEntity.prototype, "assignmentId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'project_id', type: 'uuid' }),
    __metadata("design:type", String)
], ScheduleEntity.prototype, "projectId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], ScheduleEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'scheduled_date', type: 'date' }),
    __metadata("design:type", Date)
], ScheduleEntity.prototype, "scheduledDate", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.ScheduleStatus,
        default: shared_1.ScheduleStatus.TENTATIVE,
    }),
    __metadata("design:type", String)
], ScheduleEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ScheduleEntity.prototype, "remarks", void 0);
__decorate([
    (0, typeorm_1.OneToOne)(() => assignment_entity_1.AssignmentEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assignment_id' }),
    __metadata("design:type", assignment_entity_1.AssignmentEntity)
], ScheduleEntity.prototype, "assignment", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => project_entity_1.ProjectEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'project_id' }),
    __metadata("design:type", project_entity_1.ProjectEntity)
], ScheduleEntity.prototype, "project", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], ScheduleEntity.prototype, "assayer", void 0);
exports.ScheduleEntity = ScheduleEntity = __decorate([
    (0, typeorm_1.Entity)('schedules'),
    (0, typeorm_1.Index)(['projectId']),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['status'])
], ScheduleEntity);
//# sourceMappingURL=schedule.entity.js.map