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
exports.DocumentEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const assessment_entity_1 = require("../project/assessment.entity");
const shared_1 = require("@fapoms/shared");
let DocumentEntity = class DocumentEntity extends base_entity_1.BaseEntity {
    projectBranchId;
    assessmentId;
    fileName;
    filePath;
    fileSize;
    mimeType;
    type;
    status;
    docVersion;
    customerMasterVersionId;
    dispatchedAt;
    dispatchMethod;
    dispatchedBy;
    receivedAt;
    assignedToUserId;
    assignedAt;
    assignedBy;
    dataEntryCompletedAt;
    sentToDataEntryAt;
    sentToExternalOcrAt;
    projectBranch;
    assessment;
};
exports.DocumentEntity = DocumentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'project_branch_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "projectBranchId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assessment_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "assessmentId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_name', length: 255 }),
    __metadata("design:type", String)
], DocumentEntity.prototype, "fileName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_path', type: 'text' }),
    __metadata("design:type", String)
], DocumentEntity.prototype, "filePath", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_size', type: 'integer' }),
    __metadata("design:type", Number)
], DocumentEntity.prototype, "fileSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'mime_type', type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "mimeType", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.DocumentType,
    }),
    __metadata("design:type", String)
], DocumentEntity.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: shared_1.DocumentStatus,
        default: shared_1.DocumentStatus.UPLOADED,
    }),
    __metadata("design:type", String)
], DocumentEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'doc_version', type: 'integer', default: 1 }),
    __metadata("design:type", Number)
], DocumentEntity.prototype, "docVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'customer_master_version_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "customerMasterVersionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'dispatched_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "dispatchedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'dispatch_method', type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "dispatchMethod", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'dispatched_by', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "dispatchedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'received_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "receivedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assigned_to_user_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "assignedToUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assigned_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "assignedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assigned_by', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "assignedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'data_entry_completed_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "dataEntryCompletedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'sent_to_data_entry_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "sentToDataEntryAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'sent_to_external_ocr_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "sentToExternalOcrAt", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => project_branch_entity_1.ProjectBranchEntity, { onDelete: 'CASCADE', nullable: true }),
    (0, typeorm_1.JoinColumn)({ name: 'project_branch_id' }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "projectBranch", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assessment_entity_1.AssessmentEntity, { onDelete: 'CASCADE', nullable: true }),
    (0, typeorm_1.JoinColumn)({ name: 'assessment_id' }),
    __metadata("design:type", Object)
], DocumentEntity.prototype, "assessment", void 0);
exports.DocumentEntity = DocumentEntity = __decorate([
    (0, typeorm_1.Entity)('documents'),
    (0, typeorm_1.Index)(['projectBranchId']),
    (0, typeorm_1.Index)(['assessmentId']),
    (0, typeorm_1.Index)(['status']),
    (0, typeorm_1.Index)(['type'])
], DocumentEntity);
//# sourceMappingURL=document.entity.js.map