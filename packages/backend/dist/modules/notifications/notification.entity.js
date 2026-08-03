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
exports.NotificationEntity = void 0;
const typeorm_1 = require("typeorm");
const shared_1 = require("@fapoms/shared");
const base_entity_1 = require("../../core/entities/base.entity");
const user_entity_1 = require("../user/user.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
let NotificationEntity = class NotificationEntity extends base_entity_1.BaseEntity {
    userId;
    assayerId;
    title;
    message;
    isRead;
    link;
    type;
    category;
    priority;
    status;
    channels;
    sentAt;
    deliveredAt;
    readAt;
    failedAt;
    failureReason;
    attempts;
    entityType;
    entityId;
    payload;
    sourceEventId;
    actorUserId;
    dedupeKey;
    groupKey;
    user;
    assayer;
};
exports.NotificationEntity = NotificationEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'user_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'assayer_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "assayerId", void 0);
__decorate([
    (0, typeorm_1.Column)({ length: 255 }),
    __metadata("design:type", String)
], NotificationEntity.prototype, "title", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], NotificationEntity.prototype, "message", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'is_read', type: 'boolean', default: false }),
    __metadata("design:type", Boolean)
], NotificationEntity.prototype, "isRead", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'link', type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "link", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 64, nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 32, default: shared_1.NotificationCategory.SYSTEM }),
    __metadata("design:type", String)
], NotificationEntity.prototype, "category", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: shared_1.NotificationPriority.NORMAL }),
    __metadata("design:type", String)
], NotificationEntity.prototype, "priority", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 16, default: shared_1.NotificationStatus.PENDING }),
    __metadata("design:type", String)
], NotificationEntity.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', default: () => `'["IN_APP"]'::jsonb` }),
    __metadata("design:type", Array)
], NotificationEntity.prototype, "channels", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'sent_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "sentAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'delivered_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "deliveredAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'read_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "readAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'failed_at', type: 'timestamptz', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "failedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'failure_reason', type: 'text', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "failureReason", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'integer', default: 0 }),
    __metadata("design:type", Number)
], NotificationEntity.prototype, "attempts", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'entity_type', type: 'varchar', length: 64, nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "entityType", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'entity_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "entityId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "payload", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'source_event_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "sourceEventId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'actor_user_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "actorUserId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'dedupe_key', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "dedupeKey", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'group_key', type: 'varchar', length: 200, nullable: true }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "groupKey", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => user_entity_1.UserEntity, { onDelete: 'CASCADE', nullable: true }),
    (0, typeorm_1.JoinColumn)({ name: 'user_id' }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "user", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => assayer_entity_1.AssayerEntity, { onDelete: 'CASCADE', nullable: true }),
    (0, typeorm_1.JoinColumn)({ name: 'assayer_id' }),
    __metadata("design:type", Object)
], NotificationEntity.prototype, "assayer", void 0);
exports.NotificationEntity = NotificationEntity = __decorate([
    (0, typeorm_1.Entity)('notifications'),
    (0, typeorm_1.Index)(['userId']),
    (0, typeorm_1.Index)(['assayerId']),
    (0, typeorm_1.Index)(['isRead']),
    (0, typeorm_1.Index)(['status']),
    (0, typeorm_1.Index)(['category']),
    (0, typeorm_1.Index)(['entityType', 'entityId']),
    (0, typeorm_1.Index)(['userId', 'isRead', 'createdAt']),
    (0, typeorm_1.Index)('UQ_notifications_dedupe', ['dedupeKey'], { unique: true, where: '"dedupe_key" IS NOT NULL' })
], NotificationEntity);
//# sourceMappingURL=notification.entity.js.map