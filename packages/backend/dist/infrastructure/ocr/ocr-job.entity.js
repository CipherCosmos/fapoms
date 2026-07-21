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
exports.OcrJobEntity = exports.OcrJobStatus = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const document_entity_1 = require("../../modules/document/document.entity");
var OcrJobStatus;
(function (OcrJobStatus) {
    OcrJobStatus["PENDING"] = "PENDING";
    OcrJobStatus["PROCESSING"] = "PROCESSING";
    OcrJobStatus["COMPLETED"] = "COMPLETED";
    OcrJobStatus["FAILED"] = "FAILED";
})(OcrJobStatus || (exports.OcrJobStatus = OcrJobStatus = {}));
let OcrJobEntity = class OcrJobEntity extends base_entity_1.BaseEntity {
    documentId;
    externalJobId;
    status;
    ocrPayload;
    retryCount;
    failureReason;
    document;
};
exports.OcrJobEntity = OcrJobEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'document_id', type: 'uuid' }),
    __metadata("design:type", String)
], OcrJobEntity.prototype, "documentId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'external_job_id', type: 'varchar', length: 150, nullable: true }),
    __metadata("design:type", Object)
], OcrJobEntity.prototype, "externalJobId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: OcrJobStatus,
        default: OcrJobStatus.PENDING,
    }),
    __metadata("design:type", String)
], OcrJobEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'ocr_payload', type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], OcrJobEntity.prototype, "ocrPayload", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'retry_count', type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], OcrJobEntity.prototype, "retryCount", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'failure_reason', type: 'text', nullable: true }),
    __metadata("design:type", Object)
], OcrJobEntity.prototype, "failureReason", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => document_entity_1.DocumentEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'document_id' }),
    __metadata("design:type", document_entity_1.DocumentEntity)
], OcrJobEntity.prototype, "document", void 0);
exports.OcrJobEntity = OcrJobEntity = __decorate([
    (0, typeorm_1.Entity)('ocr_jobs'),
    (0, typeorm_1.Index)(['documentId']),
    (0, typeorm_1.Index)(['status'])
], OcrJobEntity);
//# sourceMappingURL=ocr-job.entity.js.map