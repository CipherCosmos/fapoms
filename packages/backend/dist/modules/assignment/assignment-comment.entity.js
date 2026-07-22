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
exports.AssignmentCommentEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
const assignment_entity_1 = require("./assignment.entity");
let AssignmentCommentEntity = class AssignmentCommentEntity extends base_entity_1.BaseEntity {
    assignmentId;
    userId;
    userName;
    comment;
    assignment;
};
exports.AssignmentCommentEntity = AssignmentCommentEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'assignment_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssignmentCommentEntity.prototype, "assignmentId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'user_id', type: 'uuid' }),
    __metadata("design:type", String)
], AssignmentCommentEntity.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'user_name', type: 'varchar', length: 255 }),
    __metadata("design:type", String)
], AssignmentCommentEntity.prototype, "userName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], AssignmentCommentEntity.prototype, "comment", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assignment_entity_1.AssignmentEntity, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'assignment_id' }),
    __metadata("design:type", assignment_entity_1.AssignmentEntity)
], AssignmentCommentEntity.prototype, "assignment", void 0);
exports.AssignmentCommentEntity = AssignmentCommentEntity = __decorate([
    (0, typeorm_1.Entity)('assignment_comments'),
    (0, typeorm_1.Index)(['assignmentId'])
], AssignmentCommentEntity);
//# sourceMappingURL=assignment-comment.entity.js.map