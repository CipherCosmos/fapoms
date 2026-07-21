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
exports.BusinessRuleEntity = void 0;
const typeorm_1 = require("typeorm");
const base_entity_1 = require("../../core/entities/base.entity");
let BusinessRuleEntity = class BusinessRuleEntity extends base_entity_1.BaseEntity {
    name;
    scope;
    targetId;
    ruleType;
    conditions;
    actions;
};
exports.BusinessRuleEntity = BusinessRuleEntity;
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 150 }),
    __metadata("design:type", String)
], BusinessRuleEntity.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 50 }),
    __metadata("design:type", String)
], BusinessRuleEntity.prototype, "scope", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'target_id', type: 'uuid', nullable: true }),
    __metadata("design:type", Object)
], BusinessRuleEntity.prototype, "targetId", void 0);
__decorate([
    (0, typeorm_1.Column)({ name: 'rule_type', type: 'varchar', length: 100 }),
    __metadata("design:type", String)
], BusinessRuleEntity.prototype, "ruleType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb' }),
    __metadata("design:type", Object)
], BusinessRuleEntity.prototype, "conditions", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'jsonb', nullable: true }),
    __metadata("design:type", Object)
], BusinessRuleEntity.prototype, "actions", void 0);
exports.BusinessRuleEntity = BusinessRuleEntity = __decorate([
    (0, typeorm_1.Entity)('business_rules'),
    (0, typeorm_1.Index)(['scope', 'targetId'])
], BusinessRuleEntity);
//# sourceMappingURL=business-rule.entity.js.map