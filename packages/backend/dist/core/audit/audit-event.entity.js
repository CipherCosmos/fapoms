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
exports.AuditEventEntity = void 0;
const typeorm_1 = require("typeorm");
let AuditEventEntity = class AuditEventEntity {
    id;
    category;
    eventType;
    entityType;
    entityId;
    previousState;
    newState;
    userId;
    userDisplayName;
    ipAddress;
    remarks;
    metadata;
    occurredAt;
};
exports.AuditEventEntity = AuditEventEntity;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], AuditEventEntity.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'varchar',
        length: 50,
        comment: 'Event category: OPERATIONAL, USER, WORKFLOW, SYSTEM',
    }),
    __metadata("design:type", String)
], AuditEventEntity.prototype, "category", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'event_type',
        type: 'varchar',
        length: 100,
        comment: 'Specific event type, e.g. ASSIGNMENT_ACCEPTED, PROJECT_CREATED',
    }),
    __metadata("design:type", String)
], AuditEventEntity.prototype, "eventType", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'entity_type',
        type: 'varchar',
        length: 100,
        comment: 'Type of entity this event relates to, e.g. PROJECT, ASSIGNMENT',
    }),
    __metadata("design:type", String)
], AuditEventEntity.prototype, "entityType", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'entity_id',
        type: 'uuid',
        comment: 'ID of the entity this event relates to',
    }),
    __metadata("design:type", String)
], AuditEventEntity.prototype, "entityId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'previous_state',
        type: 'varchar',
        length: 50,
        nullable: true,
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "previousState", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'new_state',
        type: 'varchar',
        length: 50,
        nullable: true,
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "newState", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'user_id',
        type: 'uuid',
        nullable: true,
        comment: 'User who triggered the event (null for system events)',
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "userId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'user_display_name',
        type: 'varchar',
        length: 200,
        nullable: true,
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "userDisplayName", void 0);
__decorate([
    (0, typeorm_1.Column)({
        name: 'ip_address',
        type: 'varchar',
        length: 50,
        nullable: true,
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "ipAddress", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'text',
        nullable: true,
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "remarks", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'jsonb',
        nullable: true,
        comment: 'Additional structured data about the event',
    }),
    __metadata("design:type", Object)
], AuditEventEntity.prototype, "metadata", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)({
        name: 'occurred_at',
        type: 'timestamptz',
    }),
    __metadata("design:type", Date)
], AuditEventEntity.prototype, "occurredAt", void 0);
exports.AuditEventEntity = AuditEventEntity = __decorate([
    (0, typeorm_1.Entity)('audit_events'),
    (0, typeorm_1.Index)(['entityType', 'entityId']),
    (0, typeorm_1.Index)(['occurredAt']),
    (0, typeorm_1.Index)(['userId']),
    (0, typeorm_1.Index)(['category'])
], AuditEventEntity);
//# sourceMappingURL=audit-event.entity.js.map