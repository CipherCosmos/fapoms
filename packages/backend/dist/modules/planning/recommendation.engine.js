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
exports.RecommendationEngine = exports.RiskScoreCalculator = exports.ProfitabilityScoreCalculator = exports.SLAComplianceScoreCalculator = exports.BranchFamiliarityScoreCalculator = exports.ClientPreferenceScoreCalculator = exports.CostScoreCalculator = exports.ExperienceScoreCalculator = exports.PerformanceScoreCalculator = exports.WorkloadScoreCalculator = exports.TravelTimeScoreCalculator = exports.DistanceScoreCalculator = exports.RuleEngineEligibilityFilter = exports.ClientRestrictionFilter = exports.AvailabilityFilter = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const assayer_entity_1 = require("../assayer/assayer.entity");
const routing_provider_1 = require("../geo/routing.provider");
const assignment_entity_1 = require("../assignment/assignment.entity");
const shared_1 = require("@fapoms/shared");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const client_entity_1 = require("../client/client.entity");
const rule_engine_1 = require("../platform/rules/rule.engine");
const configuration_resolver_1 = require("../platform/configuration/configuration.resolver");
let AvailabilityFilter = class AvailabilityFilter {
    assignmentRepository;
    name = 'availability';
    constructor(assignmentRepository) {
        this.assignmentRepository = assignmentRepository;
    }
    async evaluate(assayer, context) {
        if (assayer.status !== 'ACTIVE' || !assayer.isActive) {
            return false;
        }
        const doubleBooked = await this.assignmentRepository.findOne({
            where: {
                assayerId: assayer.id,
                scheduledDate: context.scheduledDate,
                status: (0, typeorm_2.In)([shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.SCHEDULED]),
                isActive: true,
            },
        });
        return !doubleBooked;
    }
};
exports.AvailabilityFilter = AvailabilityFilter;
exports.AvailabilityFilter = AvailabilityFilter = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], AvailabilityFilter);
let ClientRestrictionFilter = class ClientRestrictionFilter {
    name = 'clientRestriction';
    async evaluate(assayer, context) {
        if (!context.client)
            return true;
        const restricted = context.client.restrictedAssayers || [];
        return !restricted.includes(assayer.id);
    }
};
exports.ClientRestrictionFilter = ClientRestrictionFilter;
exports.ClientRestrictionFilter = ClientRestrictionFilter = __decorate([
    (0, common_1.Injectable)()
], ClientRestrictionFilter);
let RuleEngineEligibilityFilter = class RuleEngineEligibilityFilter {
    ruleEngine;
    name = 'ruleEngineEligibility';
    constructor(ruleEngine) {
        this.ruleEngine = ruleEngine;
    }
    async evaluate(assayer, context) {
        const results = await this.ruleEngine.evaluate({
            subject: {
                id: assayer.id,
                state: assayer.state,
                skills: assayer.skills || [],
                certifications: assayer.certifications || [],
            },
            target: {
                id: context.branch.id,
                clientId: context.branch.clientId,
            },
            scheduledDate: context.scheduledDate,
            restrictedAssayers: context.client?.restrictedAssayers,
        });
        return !results.some((r) => !r.passed && r.actionType === 'BLOCK');
    }
};
exports.RuleEngineEligibilityFilter = RuleEngineEligibilityFilter;
exports.RuleEngineEligibilityFilter = RuleEngineEligibilityFilter = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [rule_engine_1.RuleEngine])
], RuleEngineEligibilityFilter);
let DistanceScoreCalculator = class DistanceScoreCalculator {
    routingService;
    name = 'distance';
    constructor(routingService) {
        this.routingService = routingService;
    }
    async calculate(assayer, context) {
        if (!context.branch.latitude || !context.branch.longitude || !assayer.latitude || !assayer.longitude) {
            return 0;
        }
        const route = await this.routingService.calculateRoute({ latitude: context.branch.latitude, longitude: context.branch.longitude }, { latitude: assayer.latitude, longitude: assayer.longitude });
        return Math.max(0, 100 - route.distanceKm);
    }
};
exports.DistanceScoreCalculator = DistanceScoreCalculator;
exports.DistanceScoreCalculator = DistanceScoreCalculator = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [routing_provider_1.RoutingService])
], DistanceScoreCalculator);
let TravelTimeScoreCalculator = class TravelTimeScoreCalculator {
    routingService;
    name = 'travelTime';
    constructor(routingService) {
        this.routingService = routingService;
    }
    async calculate(assayer, context) {
        if (!context.branch.latitude || !context.branch.longitude || !assayer.latitude || !assayer.longitude) {
            return 0;
        }
        const route = await this.routingService.calculateRoute({ latitude: context.branch.latitude, longitude: context.branch.longitude }, { latitude: assayer.latitude, longitude: assayer.longitude });
        return Math.max(0, 100 - route.durationMinutes);
    }
};
exports.TravelTimeScoreCalculator = TravelTimeScoreCalculator;
exports.TravelTimeScoreCalculator = TravelTimeScoreCalculator = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [routing_provider_1.RoutingService])
], TravelTimeScoreCalculator);
let WorkloadScoreCalculator = class WorkloadScoreCalculator {
    assignmentRepository;
    name = 'workload';
    constructor(assignmentRepository) {
        this.assignmentRepository = assignmentRepository;
    }
    async calculate(assayer, context) {
        const activeCount = await this.assignmentRepository.count({
            where: {
                assayerId: assayer.id,
                status: (0, typeorm_2.In)([shared_1.AssignmentStatus.CREATED, shared_1.AssignmentStatus.ACCEPTED, shared_1.AssignmentStatus.SCHEDULED]),
                isActive: true,
            },
        });
        const maxCapacity = assayer.maxWeeklyWorkload || 15;
        const remaining = Math.max(0, maxCapacity - activeCount);
        return Math.min(100, (remaining / maxCapacity) * 100);
    }
};
exports.WorkloadScoreCalculator = WorkloadScoreCalculator;
exports.WorkloadScoreCalculator = WorkloadScoreCalculator = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], WorkloadScoreCalculator);
let PerformanceScoreCalculator = class PerformanceScoreCalculator {
    name = 'performance';
    async calculate(assayer) {
        const rating = assayer.performanceRating || 5.0;
        return (rating / 5.0) * 100;
    }
};
exports.PerformanceScoreCalculator = PerformanceScoreCalculator;
exports.PerformanceScoreCalculator = PerformanceScoreCalculator = __decorate([
    (0, common_1.Injectable)()
], PerformanceScoreCalculator);
let ExperienceScoreCalculator = class ExperienceScoreCalculator {
    name = 'experience';
    async calculate(assayer) {
        const exp = assayer.experienceYears || 0;
        return Math.min(100, (exp / 10) * 100);
    }
};
exports.ExperienceScoreCalculator = ExperienceScoreCalculator;
exports.ExperienceScoreCalculator = ExperienceScoreCalculator = __decorate([
    (0, common_1.Injectable)()
], ExperienceScoreCalculator);
let CostScoreCalculator = class CostScoreCalculator {
    commercialRepository;
    name = 'cost';
    constructor(commercialRepository) {
        this.commercialRepository = commercialRepository;
    }
    async calculate(assayer, context) {
        const profiles = await this.commercialRepository.find({
            where: { assayerId: assayer.id, isActive: true },
            order: { effectiveStartDate: 'DESC' },
        });
        let activeProfile = null;
        const targetDate = context.scheduledDate;
        for (const p of profiles) {
            if (p.effectiveStartDate <= targetDate && (!p.effectiveEndDate || p.effectiveEndDate >= targetDate)) {
                activeProfile = p;
                break;
            }
        }
        if (!activeProfile) {
            return 50;
        }
        const baseFee = Number(activeProfile.baseFee) || 0;
        return Math.max(0, 100 - (baseFee / 5000) * 100);
    }
};
exports.CostScoreCalculator = CostScoreCalculator;
exports.CostScoreCalculator = CostScoreCalculator = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], CostScoreCalculator);
let ClientPreferenceScoreCalculator = class ClientPreferenceScoreCalculator {
    name = 'clientPreference';
    async calculate(assayer, context) {
        if (context.client?.preferredAssayers?.includes(assayer.id)) {
            return 100;
        }
        return 50;
    }
};
exports.ClientPreferenceScoreCalculator = ClientPreferenceScoreCalculator;
exports.ClientPreferenceScoreCalculator = ClientPreferenceScoreCalculator = __decorate([
    (0, common_1.Injectable)()
], ClientPreferenceScoreCalculator);
let BranchFamiliarityScoreCalculator = class BranchFamiliarityScoreCalculator {
    assignmentRepository;
    name = 'branchFamiliarity';
    constructor(assignmentRepository) {
        this.assignmentRepository = assignmentRepository;
    }
    async calculate(assayer, context) {
        const count = await this.assignmentRepository.count({
            where: {
                assayerId: assayer.id,
                projectId: context.branch.clientId ? context.branch.clientId : undefined,
                status: shared_1.AssignmentStatus.CLOSED,
                isActive: true,
            },
        });
        return Math.min(100, 50 + count * 10);
    }
};
exports.BranchFamiliarityScoreCalculator = BranchFamiliarityScoreCalculator;
exports.BranchFamiliarityScoreCalculator = BranchFamiliarityScoreCalculator = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assignment_entity_1.AssignmentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], BranchFamiliarityScoreCalculator);
let SLAComplianceScoreCalculator = class SLAComplianceScoreCalculator {
    name = 'slaCompliance';
    async calculate() {
        return 100;
    }
};
exports.SLAComplianceScoreCalculator = SLAComplianceScoreCalculator;
exports.SLAComplianceScoreCalculator = SLAComplianceScoreCalculator = __decorate([
    (0, common_1.Injectable)()
], SLAComplianceScoreCalculator);
let ProfitabilityScoreCalculator = class ProfitabilityScoreCalculator {
    commercialRepository;
    name = 'profitability';
    constructor(commercialRepository) {
        this.commercialRepository = commercialRepository;
    }
    async calculate(assayer, context) {
        const budget = context.client?.budget ? Number(context.client.budget) : 0;
        if (budget <= 0)
            return 100;
        const profile = await this.commercialRepository.findOne({
            where: { assayerId: assayer.id, isActive: true },
            order: { effectiveStartDate: 'DESC' },
        });
        if (!profile)
            return 50;
        const totalCost = Number(profile.baseFee) + Number(profile.dailyRate);
        if (totalCost > budget) {
            return Math.max(0, 50 - ((totalCost - budget) / budget) * 50);
        }
        return Math.min(100, 50 + ((budget - totalCost) / budget) * 50);
    }
};
exports.ProfitabilityScoreCalculator = ProfitabilityScoreCalculator;
exports.ProfitabilityScoreCalculator = ProfitabilityScoreCalculator = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], ProfitabilityScoreCalculator);
let RiskScoreCalculator = class RiskScoreCalculator {
    name = 'riskScore';
    async calculate(assayer, context) {
        const risk = Number(context.branch.riskScore) || 0;
        if (risk < 50)
            return 100;
        const exp = assayer.experienceYears || 0;
        const rating = assayer.performanceRating || 5.0;
        if (exp >= 5 && rating >= 4.5) {
            return 100;
        }
        return Math.max(0, 100 - risk);
    }
};
exports.RiskScoreCalculator = RiskScoreCalculator;
exports.RiskScoreCalculator = RiskScoreCalculator = __decorate([
    (0, common_1.Injectable)()
], RiskScoreCalculator);
let RecommendationEngine = class RecommendationEngine {
    availabilityFilter;
    clientRestrictionFilter;
    ruleEngineEligibilityFilter;
    distanceCalculator;
    travelTimeCalculator;
    workloadCalculator;
    performanceCalculator;
    experienceCalculator;
    costCalculator;
    clientPreferenceCalculator;
    branchFamiliarityCalculator;
    slaComplianceCalculator;
    profitabilityCalculator;
    riskCalculator;
    configResolver;
    assayerRepository;
    clientRepository;
    filters = [];
    calculators = [];
    constructor(availabilityFilter, clientRestrictionFilter, ruleEngineEligibilityFilter, distanceCalculator, travelTimeCalculator, workloadCalculator, performanceCalculator, experienceCalculator, costCalculator, clientPreferenceCalculator, branchFamiliarityCalculator, slaComplianceCalculator, profitabilityCalculator, riskCalculator, configResolver, assayerRepository, clientRepository) {
        this.availabilityFilter = availabilityFilter;
        this.clientRestrictionFilter = clientRestrictionFilter;
        this.ruleEngineEligibilityFilter = ruleEngineEligibilityFilter;
        this.distanceCalculator = distanceCalculator;
        this.travelTimeCalculator = travelTimeCalculator;
        this.workloadCalculator = workloadCalculator;
        this.performanceCalculator = performanceCalculator;
        this.experienceCalculator = experienceCalculator;
        this.costCalculator = costCalculator;
        this.clientPreferenceCalculator = clientPreferenceCalculator;
        this.branchFamiliarityCalculator = branchFamiliarityCalculator;
        this.slaComplianceCalculator = slaComplianceCalculator;
        this.profitabilityCalculator = profitabilityCalculator;
        this.riskCalculator = riskCalculator;
        this.configResolver = configResolver;
        this.assayerRepository = assayerRepository;
        this.clientRepository = clientRepository;
        this.filters.push(this.availabilityFilter, this.clientRestrictionFilter, this.ruleEngineEligibilityFilter);
        this.calculators.push(this.distanceCalculator, this.travelTimeCalculator, this.workloadCalculator, this.performanceCalculator, this.experienceCalculator, this.costCalculator, this.clientPreferenceCalculator, this.branchFamiliarityCalculator, this.slaComplianceCalculator, this.profitabilityCalculator, this.riskCalculator);
    }
    async recommend(branch, scheduledDate, weights = {}) {
        const client = branch.clientId
            ? await this.clientRepository.findOne({ where: { id: branch.clientId, isActive: true } })
            : null;
        const resolvedConfig = this.configResolver.resolveRecommendationConfig(client, { weights });
        const context = {
            branch,
            client,
            scheduledDate,
            weights: resolvedConfig.weights,
        };
        const assayers = await this.assayerRepository.find({
            where: { isActive: true, status: 'ACTIVE' },
        });
        const candidates = [];
        for (const assayer of assayers) {
            let passed = true;
            for (const filter of this.filters) {
                if (!(await filter.evaluate(assayer, context))) {
                    passed = false;
                    break;
                }
            }
            if (!passed)
                continue;
            let weightedSum = 0;
            let totalWeight = 0;
            const scoreBreakdown = {};
            for (const calculator of this.calculators) {
                const score = await calculator.calculate(assayer, context);
                scoreBreakdown[calculator.name] = score;
                const weight = context.weights[calculator.name] ?? 0;
                weightedSum += score * weight;
                totalWeight += weight;
            }
            const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
            candidates.push({
                assayer,
                score: parseFloat(finalScore.toFixed(2)),
                breakdown: scoreBreakdown,
            });
        }
        return candidates.sort((a, b) => b.score - a.score);
    }
};
exports.RecommendationEngine = RecommendationEngine;
exports.RecommendationEngine = RecommendationEngine = __decorate([
    (0, common_1.Injectable)(),
    __param(15, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(16, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __metadata("design:paramtypes", [AvailabilityFilter,
        ClientRestrictionFilter,
        RuleEngineEligibilityFilter,
        DistanceScoreCalculator,
        TravelTimeScoreCalculator,
        WorkloadScoreCalculator,
        PerformanceScoreCalculator,
        ExperienceScoreCalculator,
        CostScoreCalculator,
        ClientPreferenceScoreCalculator,
        BranchFamiliarityScoreCalculator,
        SLAComplianceScoreCalculator,
        ProfitabilityScoreCalculator,
        RiskScoreCalculator,
        configuration_resolver_1.ConfigurationResolver,
        typeorm_2.Repository,
        typeorm_2.Repository])
], RecommendationEngine);
//# sourceMappingURL=recommendation.engine.js.map