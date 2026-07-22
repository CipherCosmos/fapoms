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
exports.BranchDocumentEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let BranchDocumentEntity = class BranchDocumentEntity extends base_entity_1.BaseEntity {
    branchId;
    branch;
    fileName;
    filePath;
    fileSize;
    mimeType;
    category;
    remarks;
};
exports.BranchDocumentEntity = BranchDocumentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'branch_id', type: 'uuid' }),
    __metadata("design:type", String)
], BranchDocumentEntity.prototype, "branchId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)('BranchEntity', 'documents', { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'branch_id' }),
    __metadata("design:type", Function)
], BranchDocumentEntity.prototype, "branch", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_name', length: 255 }),
    __metadata("design:type", String)
], BranchDocumentEntity.prototype, "fileName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_path', type: 'text' }),
    __metadata("design:type", String)
], BranchDocumentEntity.prototype, "filePath", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_size', type: 'integer' }),
    __metadata("design:type", Number)
], BranchDocumentEntity.prototype, "fileSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'mime_type', type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], BranchDocumentEntity.prototype, "mimeType", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 50 }),
    __metadata("design:type", String)
], BranchDocumentEntity.prototype, "category", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], BranchDocumentEntity.prototype, "remarks", void 0);
exports.BranchDocumentEntity = BranchDocumentEntity = __decorate([
    (0, typeorm_1.Entity)('branch_documents'),
    (0, typeorm_1.Index)(['branchId'])
], BranchDocumentEntity);
//# sourceMappingURL=branch-document.entity.js.map