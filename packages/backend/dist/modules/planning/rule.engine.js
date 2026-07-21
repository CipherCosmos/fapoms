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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuleEngine = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const business_rule_entity_1 = require("./business-rule.entity");
let RuleEngine = class RuleEngine {
    ruleRepository;
    constructor(ruleRepository) {
        this.ruleRepository = ruleRepository;
    }
    async evaluate(context) {
        const rules = await this.ruleRepository.find({
            where: [
                { scope: 'GLOBAL', isActive: true },
                { scope: 'CLIENT', targetId: context.branch.clientId || undefined, isActive: true },
                { scope: 'BRANCH', targetId: context.branch.id, isActive: true },
            ],
        });
        const results = [];
        for (const rule of rules) {
            const result = this.evaluateSingleRule(rule, context);
            results.push(result);
        }
        return results;
    }
    evaluateSingleRule(rule, context) {
        const { assayer, branch, client, activeWorkload } = context;
        const cond = rule.conditions || {};
        const action = rule.actions || {};
        const actionType = action.type || 'BLOCK';
        const scoreModifier = typeof action.value === 'number' ? action.value : undefined;
        if (rule.ruleType === 'CERTIFICATION' && cond.requiredCertification) {
            const required = String(cond.requiredCertification).toLowerCase();
            const hasCert = assayer.certifications?.some((c) => c.name.toLowerCase() === required &&
                (!c.expiryDate || new Date(c.expiryDate) > context.scheduledDate));
            if (!hasCert) {
                return {
                    passed: false,
                    actionType,
                    scoreModifier,
                    message: `Missing required certification: ${cond.requiredCertification}`,
                };
            }
        }
        if (rule.ruleType === 'SKILL' && cond.requiredSkill) {
            const required = String(cond.requiredSkill).toLowerCase();
            const hasSkill = assayer.skills?.some((s) => s.toLowerCase() === required);
            if (!hasSkill) {
                return {
                    passed: false,
                    actionType,
                    scoreModifier,
                    message: `Missing required skill: ${cond.requiredSkill}`,
                };
            }
        }
        if (rule.ruleType === 'TERRITORY' && cond.restrictedStates) {
            const restricted = Array.isArray(cond.restrictedStates) ? cond.restrictedStates : [];
            if (restricted.some((state) => String(state).toLowerCase() === assayer.state.toLowerCase())) {
                return {
                    passed: false,
                    actionType,
                    scoreModifier,
                    message: `Restricted state territory: ${assayer.state}`,
                };
            }
        }
        if (rule.ruleType === 'CAPACITY' && cond.maxWeeklyCapacity) {
            const currentLoad = activeWorkload || 0;
            if (currentLoad >= Number(cond.maxWeeklyCapacity)) {
                return {
                    passed: false,
                    actionType,
                    scoreModifier,
                    message: `Weekly workload (${currentLoad}) exceeds capacity limit (${cond.maxWeeklyCapacity})`,
                };
            }
        }
        if (rule.ruleType === 'PREFERENCE' && client?.restrictedAssayers) {
            if (client.restrictedAssayers.includes(assayer.id)) {
                return {
                    passed: false,
                    actionType,
                    scoreModifier,
                    message: `Assayer restricted by client preferences`,
                };
            }
        }
        return { passed: true, actionType: 'ALERT' };
    }
};
exports.RuleEngine = RuleEngine;
exports.RuleEngine = RuleEngine = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(business_rule_entity_1.BusinessRuleEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], RuleEngine);
//# sourceMappingURL=rule.engine.js.map