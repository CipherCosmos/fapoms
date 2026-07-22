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
exports.AssayerDocumentEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assayer_entity_1 = require("./assayer.entity");
let AssayerDocumentEntity = class AssayerDocumentEntity extends base_entity_1.BaseEntity {
    assayerId;
    assayer;
    documentType;
    fileName;
    filePath;
    fileSize;
    mimeType;
    docVersion;
    parentDocumentId;
    remarks;
};
exports.AssayerDocumentEntity = AssayerDocumentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerDocumentEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], AssayerDocumentEntity.prototype, "assayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'document_type', length: 50 }),
    __metadata("design:type", String)
], AssayerDocumentEntity.prototype, "documentType", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_name', length: 255 }),
    __metadata("design:type", String)
], AssayerDocumentEntity.prototype, "fileName", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_path', type: 'text' }),
    __metadata("design:type", String)
], AssayerDocumentEntity.prototype, "filePath", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_size', type: 'integer' }),
    __metadata("design:type", Number)
], AssayerDocumentEntity.prototype, "fileSize", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'mime_type', type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], AssayerDocumentEntity.prototype, "mimeType", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'doc_version', type: 'integer', default: 1 }),
    __metadata("design:type", Number)
], AssayerDocumentEntity.prototype, "docVersion", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'parent_document_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], AssayerDocumentEntity.prototype, "parentDocumentId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssayerDocumentEntity.prototype, "remarks", void 0);
exports.AssayerDocumentEntity = AssayerDocumentEntity = __decorate([
    (0, typeorm_1.Entity)('assayer_documents'),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['documentType'])
], AssayerDocumentEntity);
//# sourceMappingURL=assayer-document.entity.js.map