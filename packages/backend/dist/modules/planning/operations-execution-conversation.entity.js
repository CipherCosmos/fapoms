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
exports.OperationsExecutionConversationEntity = exports.NegotiationParticipant = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
var NegotiationParticipant;
(function (NegotiationParticipant) {
    NegotiationParticipant["OPERATIONS"] = "OPERATIONS";
    NegotiationParticipant["ASSAYER"] = "ASSAYER";
    NegotiationParticipant["SYSTEM"] = "SYSTEM";
})(NegotiationParticipant || (exports.NegotiationParticipant = NegotiationParticipant = {}));
let OperationsExecutionConversationEntity = class OperationsExecutionConversationEntity extends base_entity_1.BaseEntity {
    groupId;
    sender;
    message;
    proposedFeeOverride;
    proposedDateOverride;
};
exports.OperationsExecutionConversationEntity = OperationsExecutionConversationEntity;
__decorate([
    (0, typeorm_1.Column)({ name: 'group_id', type: 'uuid' }),
    __metadata("design:type", String)
], OperationsExecutionConversationEntity.prototype, "groupId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'enum',
        enum: NegotiationParticipant,
    }),
    __metadata("design:type", String)
], OperationsExecutionConversationEntity.prototype, "sender", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], OperationsExecutionConversationEntity.prototype, "message", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'proposed_fee_override', type: 'numeric', precision: 10, scale: 2, nullable: true }),
    __metadata("design:type", Object)
], OperationsExecutionConversationEntity.prototype, "proposedFeeOverride", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'proposed_date_override', type: 'date', nullable: true }),
    __metadata("design:type", Object)
], OperationsExecutionConversationEntity.prototype, "proposedDateOverride", void 0);
exports.OperationsExecutionConversationEntity = OperationsExecutionConversationEntity = __decorate([
    (0, typeorm_1.Entity)('operations_execution_conversations'),
    (0, typeorm_1.Index)(['groupId'])
], OperationsExecutionConversationEntity);
//# sourceMappingURL=operations-execution-conversation.entity.js.map