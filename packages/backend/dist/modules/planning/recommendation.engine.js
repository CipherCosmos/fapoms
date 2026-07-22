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
exports.RecommendationEngine = exports.RiskScoreCalculator = exports.ProfitabilityScoreCalculator = exports.SLAComplianceScoreCalculator = exports.BranchFamiliarityScoreCalculator = exports.ClientPreferenceScoreCalculator = exports.CostScoreCalculator = exports.ExperienceScoreCalculator = exports.PerformanceScoreCalculator = exports.WorkloadScoreCalculator = exports.TravelTimeScoreCalculator = exports.DistanceScoreCalculator = exports.RequiredSkillsFilter = exports.RuleEngineEligibilityFilter = exports.ClientEligibilityFilter = exports.ClientRestrictionFilter = exports.AvailabilityFilter = void 0;
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
const project_branch_entity_1 = require("../project/project-branch.entity");
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
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
let ClientEligibilityFilter = class ClientEligibilityFilter {
    name = 'clientEligibility';
    async evaluate(assayer, context) {
        if (!context.client)
            return true;
        const eligible = assayer.eligibleClients || [];
        if (eligible.length === 0 || eligible.includes('*') || eligible.includes('ANY') || eligible.includes('ALL')) {
            return true;
        }
        return eligible.includes(context.client.clientCode) || eligible.includes(context.client.id);
    }
};
exports.ClientEligibilityFilter = ClientEligibilityFilter;
exports.ClientEligibilityFilter = ClientEligibilityFilter = __decorate([
    (0, common_1.Injectable)()
], ClientEligibilityFilter);
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
let RequiredSkillsFilter = class RequiredSkillsFilter {
    projectBranchRepository;
    name = 'requiredSkills';
    constructor(projectBranchRepository) {
        this.projectBranchRepository = projectBranchRepository;
    }
    async evaluate(assayer, context) {
        const pb = await this.projectBranchRepository.findOne({
            where: { branchId: context.branch.id, isActive: true },
            relations: ['project'],
        });
        if (!pb || !pb.project) {
            return true;
        }
        const project = pb.project;
        if (project.requiredSkills && project.requiredSkills.length > 0) {
            const assayerSkills = assayer.skills || [];
            const hasAllSkills = project.requiredSkills.every((skill) => assayerSkills.some((s) => s.toLowerCase() === skill.toLowerCase()));
            if (!hasAllSkills) {
                return false;
            }
        }
        if (project.requiredCertifications && project.requiredCertifications.length > 0) {
            const assayerCerts = (assayer.certifications || []).map((c) => c.name.toLowerCase());
            const hasAllCerts = project.requiredCertifications.every((cert) => assayerCerts.includes(cert.toLowerCase()));
            if (!hasAllCerts) {
                return false;
            }
        }
        return true;
    }
};
exports.RequiredSkillsFilter = RequiredSkillsFilter;
exports.RequiredSkillsFilter = RequiredSkillsFilter = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(project_branch_entity_1.ProjectBranchEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], RequiredSkillsFilter);
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
        return Math.max(0, 100 - (route.distanceKm / 5));
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
        return Math.max(0, 100 - (route.durationMinutes / 6));
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
function getCityTierMultiplier(city) {
    if (!city)
        return 1.0;
    const c = city.trim().toLowerCase();
    const tier1 = ['mumbai', 'delhi', 'bangalore', 'bengaluru', 'chennai', 'kolkata', 'hyderabad', 'pune', 'ahmedabad', 'gurgaon', 'gurugram', 'noida'];
    if (tier1.includes(c))
        return 1.5;
    const tier2 = ['jaipur', 'lucknow', 'patna', 'bhopal', 'nagpur', 'indore', 'coimbatore', 'kochi', 'visakhapatnam', 'chandigarh', 'surat', 'vadodara', 'ludhiana', 'agra', 'nashik', 'meerut', 'rajkot', 'varanasi', 'srinagar', 'aurangabad', 'amritsar', 'allahabad', 'ranchi', 'jabalpur', 'gwalior', 'vijayawada'];
    if (tier2.includes(c))
        return 1.2;
    return 1.0;
}
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
        const multiplier = getCityTierMultiplier(context.branch.city);
        const baseFee = (Number(activeProfile.baseFee) || 0) * multiplier;
        return Math.max(0, 100 - (baseFee / 20000) * 100);
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
        let score = 50;
        const isPreferred = context.client?.preferredAssayers?.includes(assayer.id);
        if (isPreferred) {
            score = 80;
        }
        const preferences = context.client?.planningPreferences || {};
        if (context.branch.latitude && context.branch.longitude && assayer.latitude && assayer.longitude) {
            const distance = calculateHaversineDistance(Number(context.branch.latitude), Number(context.branch.longitude), Number(assayer.latitude), Number(assayer.longitude));
            const minDistance = Number(preferences.minDistanceKm);
            const maxDistance = Number(preferences.maxDistanceKm);
            if (!isNaN(minDistance) && distance < minDistance) {
                score -= 40;
            }
            if (!isNaN(maxDistance) && distance > maxDistance) {
                score -= 40;
            }
            if ((isNaN(minDistance) || distance >= minDistance) && (isNaN(maxDistance) || distance <= maxDistance)) {
                score += 10;
            }
        }
        const assayerSkills = assayer.skills || [];
        const requiredSkills = preferences.requiredSkills || [];
        const preferredSkills = preferences.preferredSkills || [];
        if (requiredSkills.length > 0) {
            const hasAllRequired = requiredSkills.every((s) => assayerSkills.some((as) => as.toLowerCase() === s.toLowerCase()));
            if (!hasAllRequired) {
                return 0;
            }
            score += 10;
        }
        if (preferredSkills.length > 0) {
            const hasAnyPreferred = preferredSkills.some((s) => assayerSkills.some((as) => as.toLowerCase() === s.toLowerCase()));
            if (hasAnyPreferred) {
                score += 10;
            }
        }
        const assayerCertifications = (assayer.certifications || []).map(c => c.name);
        const requiredCerts = preferences.requiredCertifications || [];
        const preferredCerts = preferences.preferredCertifications || [];
        if (requiredCerts.length > 0) {
            const hasAllRequired = requiredCerts.every((c) => assayerCertifications.some((ac) => ac.toLowerCase() === c.toLowerCase()));
            if (!hasAllRequired) {
                return 0;
            }
            score += 10;
        }
        if (preferredCerts.length > 0) {
            const hasAnyPreferred = preferredCerts.some((c) => assayerCertifications.some((ac) => ac.toLowerCase() === c.toLowerCase()));
            if (hasAnyPreferred) {
                score += 10;
            }
        }
        return Math.max(0, Math.min(100, score));
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
        let score = 50 + count * 10;
        if (context.scheduledDate) {
            const sameDayAssignments = await this.assignmentRepository.find({
                where: {
                    assayerId: assayer.id,
                    scheduledDate: context.scheduledDate,
                    isActive: true,
                },
                relations: ['projectBranch', 'projectBranch.branch'],
            });
            let hasNearbyGrouping = false;
            for (const assign of sameDayAssignments) {
                const otherBranch = assign.projectBranch?.branch;
                if (otherBranch && otherBranch.latitude && otherBranch.longitude && context.branch.latitude && context.branch.longitude) {
                    const dist = calculateHaversineDistance(Number(context.branch.latitude), Number(context.branch.longitude), Number(otherBranch.latitude), Number(otherBranch.longitude));
                    if (dist <= 60) {
                        hasNearbyGrouping = true;
                        break;
                    }
                }
            }
            if (hasNearbyGrouping) {
                score += 30;
            }
        }
        return Math.min(100, score);
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
    clientEligibilityFilter;
    ruleEngineEligibilityFilter;
    requiredSkillsFilter;
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
    constructor(availabilityFilter, clientRestrictionFilter, clientEligibilityFilter, ruleEngineEligibilityFilter, requiredSkillsFilter, distanceCalculator, travelTimeCalculator, workloadCalculator, performanceCalculator, experienceCalculator, costCalculator, clientPreferenceCalculator, branchFamiliarityCalculator, slaComplianceCalculator, profitabilityCalculator, riskCalculator, configResolver, assayerRepository, clientRepository) {
        this.availabilityFilter = availabilityFilter;
        this.clientRestrictionFilter = clientRestrictionFilter;
        this.clientEligibilityFilter = clientEligibilityFilter;
        this.ruleEngineEligibilityFilter = ruleEngineEligibilityFilter;
        this.requiredSkillsFilter = requiredSkillsFilter;
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
        this.filters.push(this.availabilityFilter, this.clientRestrictionFilter, this.clientEligibilityFilter, this.ruleEngineEligibilityFilter, this.requiredSkillsFilter);
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
    __param(17, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __param(18, (0, typeorm_1.InjectRepository)(client_entity_1.ClientEntity)),
    __metadata("design:paramtypes", [AvailabilityFilter,
        ClientRestrictionFilter,
        ClientEligibilityFilter,
        RuleEngineEligibilityFilter,
        RequiredSkillsFilter,
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