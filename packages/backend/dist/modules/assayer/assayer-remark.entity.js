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
exports.AssayerRemarkEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assayer_entity_1 = require("./assayer.entity");
let AssayerRemarkEntity = class AssayerRemarkEntity extends base_entity_1.BaseEntity {
    assayerId;
    assayer;
    authorId;
    authorName;
    content;
    category;
    visibility;
    attachmentPaths;
    rating;
};
exports.AssayerRemarkEntity = AssayerRemarkEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerRemarkEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", assayer_entity_1.AssayerEntity)
], AssayerRemarkEntity.prototype, "assayer", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'author_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssayerRemarkEntity.prototype, "authorId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'author_name', length: 200 }),
    __metadata("design:type", String)
], AssayerRemarkEntity.prototype, "authorName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], AssayerRemarkEntity.prototype, "content", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 50, default: 'GENERAL' }),
    __metadata("design:type", String)
], AssayerRemarkEntity.prototype, "category", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 50, default: 'PUBLIC' }),
    __metadata("design:type", String)
], AssayerRemarkEntity.prototype, "visibility", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'attachment_paths', type: 'jsonb', default: [] }),
    __metadata("design:type", Array)
], AssayerRemarkEntity.prototype, "attachmentPaths", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'decimal', precision: 3, scale: 2, nullable: true }),
    __metadata("design:type", Object)
], AssayerRemarkEntity.prototype, "rating", void 0);
exports.AssayerRemarkEntity = AssayerRemarkEntity = __decorate([
    (0, typeorm_1.Entity)('assayer_remarks'),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['category'])
], AssayerRemarkEntity);
//# sourceMappingURL=assayer-remark.entity.js.map