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
exports.ProjectEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const client_entity_1 = require("../client/client.entity");
const project_branch_entity_1 = require("./project-branch.entity");
const shared_1 = require("@fapoms/shared");
let ProjectEntity = class ProjectEntity extends base_entity_1.BaseEntity {
    projectNumber;
    name;
    description;
    clientId;
    status;
    priority;
    startDate;
    endDate;
    client;
    projectBranches;
};
exports.ProjectEntity = ProjectEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'project_number', length: 50, unique: true }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "projectNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 255 }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], ProjectEntity.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'client_id', type: 'uuid' }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "clientId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.ProjectStatus,
        default: shared_1.ProjectStatus.DRAFT,
    }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.Priority,
        default: shared_1.Priority.MEDIUM,
    }),
    __metadata("design:type", String)
], ProjectEntity.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'start_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], ProjectEntity.prototype, "startDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'end_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], ProjectEntity.prototype, "endDate", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => client_entity_1.ClientEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'client_id' }),
    __metadata("design:type", client_entity_1.ClientEntity)
], ProjectEntity.prototype, "client", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => project_branch_entity_1.ProjectBranchEntity, (pb) => pb.project),
    __metadata("design:type", Array)
], ProjectEntity.prototype, "projectBranches", void 0);
exports.ProjectEntity = ProjectEntity = __decorate([
    (0, typeorm_1.Entity)('projects'),
    (0, typeorm_1.Index)(['projectNumber']),
    (0, typeorm_1.Index)(['clientId'])
], ProjectEntity);
//# sourceMappingURL=project.entity.js.map