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
exports.PlanningService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const branch_entity_1 = require("../branch/branch.entity");
const business_rule_entity_1 = require("../platform/rules/business-rule.entity");
const recommendation_engine_1 = require("./recommendation.engine");
const routing_provider_1 = require("../geo/routing.provider");
let PlanningService = class PlanningService {
    branchRepository;
    ruleRepository;
    recommendationEngine;
    routingService;
    constructor(branchRepository, ruleRepository, recommendationEngine, routingService) {
        this.branchRepository = branchRepository;
        this.ruleRepository = ruleRepository;
        this.recommendationEngine = recommendationEngine;
        this.routingService = routingService;
    }
    async getRecommendedCandidates(branchId) {
        const branch = await this.branchRepository.findOne({
            where: { id: branchId, isActive: true },
        });
        if (!branch) {
            throw new common_1.NotFoundException(`Branch ${branchId} not found.`);
        }
        const results = await this.recommendationEngine.recommend(branch, new Date());
        const recommendations = [];
        for (const r of results) {
            let distanceKm = null;
            if (branch.latitude && branch.longitude && r.assayer.latitude && r.assayer.longitude) {
                const route = await this.routingService.calculateRoute({ latitude: branch.latitude, longitude: branch.longitude }, { latitude: r.assayer.latitude, longitude: r.assayer.longitude });
                distanceKm = route.distanceKm;
            }
            recommendations.push({
                id: r.assayer.id,
                assayerCode: r.assayer.assayerCode,
                displayName: r.assayer.displayName,
                phone: r.assayer.phone,
                email: r.assayer.email,
                status: r.assayer.status,
                state: r.assayer.state,
                district: r.assayer.district,
                city: r.assayer.city,
                distanceKm,
                score: r.score,
            });
        }
        return recommendations;
    }
    async createRule(dto, userId) {
        const rule = this.ruleRepository.create({
            ...dto,
            createdBy: userId,
            updatedBy: userId,
        });
        return this.ruleRepository.save(rule);
    }
    async updateRule(id, dto, userId) {
        const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
        if (!rule) {
            throw new common_1.NotFoundException(`Business rule ${id} not found.`);
        }
        Object.assign(rule, dto);
        rule.updatedBy = userId;
        return this.ruleRepository.save(rule);
    }
    async deleteRule(id, userId) {
        const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
        if (!rule) {
            throw new common_1.NotFoundException(`Business rule ${id} not found.`);
        }
        rule.isActive = false;
        rule.updatedBy = userId;
        await this.ruleRepository.save(rule);
    }
    async getRules(scope) {
        const where = { isActive: true };
        if (scope) {
            where.scope = scope;
        }
        return this.ruleRepository.find({ where, order: { createdAt: 'DESC' } });
    }
    async getRule(id) {
        const rule = await this.ruleRepository.findOne({ where: { id, isActive: true } });
        if (!rule) {
            throw new common_1.NotFoundException(`Business rule ${id} not found.`);
        }
        return rule;
    }
};
exports.PlanningService = PlanningService;
exports.PlanningService = PlanningService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(branch_entity_1.BranchEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(business_rule_entity_1.BusinessRuleEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        recommendation_engine_1.RecommendationEngine,
        routing_provider_1.RoutingService])
], PlanningService);
//# sourceMappingURL=planning.service.js.map