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
exports.AssayerGovernmentDocumentEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assayer_entity_1 = require("./assayer.entity");
let AssayerGovernmentDocumentEntity = class AssayerGovernmentDocumentEntity extends base_entity_1.BaseEntity {
    assayerId;
    assayer;
    documentType;
    documentNumber;
    expiryDate;
    verificationStatus;
    verifiedAt;
    verifiedBy;
    filePaths;
    remarks;
};
exports.AssayerGovernmentDocumentEntity = AssayerGovernmentDocumentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerGovernmentDocumentEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], AssayerGovernmentDocumentEntity.prototype, "assayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'document_type', length: 50 }),
    __metadata("design:type", String)
], AssayerGovernmentDocumentEntity.prototype, "documentType", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'document_number', length: 100 }),
    __metadata("design:type", String)
], AssayerGovernmentDocumentEntity.prototype, "documentNumber", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'expiry_date', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], AssayerGovernmentDocumentEntity.prototype, "expiryDate", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'verification_status', length: 20, default: 'PENDING' }),
    __metadata("design:type", String)
], AssayerGovernmentDocumentEntity.prototype, "verificationStatus", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'verified_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], AssayerGovernmentDocumentEntity.prototype, "verifiedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'verified_by', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], AssayerGovernmentDocumentEntity.prototype, "verifiedBy", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'file_paths', type: 'jsonb', default: [] }),
    __metadata("design:type", Array)
], AssayerGovernmentDocumentEntity.prototype, "filePaths", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AssayerGovernmentDocumentEntity.prototype, "remarks", void 0);
exports.AssayerGovernmentDocumentEntity = AssayerGovernmentDocumentEntity = __decorate([
    (0, typeorm_1.Entity)('assayer_government_documents'),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['documentType']),
    (0, typeorm_1.Index)(['verificationStatus'])
], AssayerGovernmentDocumentEntity);
//# sourceMappingURL=assayer-government-document.entity.js.map