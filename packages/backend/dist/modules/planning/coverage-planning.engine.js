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
exports.CoveragePlanningEngine = void 0;
const common_1 = require("@nestjs/common");
const project_query_service_1 = require("../project/project-query.service");
const recommendation_engine_1 = require("./recommendation.engine");
const constraint_evaluator_1 = require("./constraint.evaluator");
const cluster_manager_1 = require("./cluster.manager");
let CoveragePlanningEngine = class CoveragePlanningEngine {
    projectQueryService;
    recommendationEngine;
    constraintEvaluator;
    clusterManager;
    branchProvider;
    assayerProvider;
    workloadProvider;
    constructor(projectQueryService, recommendationEngine, constraintEvaluator, clusterManager, branchProvider, assayerProvider, workloadProvider) {
        this.projectQueryService = projectQueryService;
        this.recommendationEngine = recommendationEngine;
        this.constraintEvaluator = constraintEvaluator;
        this.clusterManager = clusterManager;
        this.branchProvider = branchProvider;
        this.assayerProvider = assayerProvider;
        this.workloadProvider = workloadProvider;
    }
    async generateCoveragePlan(projectId) {
        const project = await this.projectQueryService.findOne(projectId);
        const planningBranches = await this.branchProvider.getBranchesForPlanning(projectId);
        const activeBranches = planningBranches.map((pb) => {
            return {
                id: pb.branchId.value,
                name: pb.name,
                latitude: pb.location.latitude,
                longitude: pb.location.longitude,
            };
        });
        const clusters = this.clusterManager.clusterBranches(activeBranches);
        const activeAssayers = await this.assayerProvider.getAvailableAssayers(new Date());
        const assayerIds = activeAssayers.map((a) => a.assayerId.value);
        const allocationMap = await this.workloadProvider.getAssayerCurrentWorkloads(assayerIds);
        const workforceCapacity = activeAssayers.map((a) => {
            const weeklyCapacity = a.maxWeeklyWorkload || 15;
            const currentAllocation = allocationMap[a.assayerId.value] || 0;
            const remainingCapacity = Math.max(0, weeklyCapacity - currentAllocation);
            const utilizationPercentage = parseFloat(((currentAllocation / weeklyCapacity) * 100).toFixed(1));
            return {
                assayerId: a.assayerId.value,
                displayName: a.displayName,
                weeklyCapacity,
                currentAllocation,
                remainingCapacity,
                utilizationPercentage,
            };
        });
        const uncoveredBranches = [];
        const warnings = [];
        let matchedCount = 0;
        let totalEstimatedCost = 0;
        const assignedAssayerIds = new Set();
        const clusterAssignments = [];
        for (const cluster of clusters) {
            let assignedAssayerName = null;
            let highestScore = -1;
            let selectedAssayer = null;
            const clusterCenterBranch = {
                id: cluster.id,
                latitude: cluster.centerLatitude,
                longitude: cluster.centerLongitude,
                clientId: project.clientId,
            };
            const candidates = await this.recommendationEngine.recommend(clusterCenterBranch, new Date());
            const validCandidates = candidates.filter((c) => {
                const remaining = (allocationMap[c.assayer.id] || 0) < (c.assayer.maxWeeklyWorkload || 15);
                return remaining;
            });
            if (validCandidates.length > 0) {
                selectedAssayer = validCandidates[0].assayer;
                highestScore = validCandidates[0].score;
                assignedAssayerName = selectedAssayer.displayName;
                assignedAssayerIds.add(selectedAssayer.id);
                allocationMap[selectedAssayer.id] = (allocationMap[selectedAssayer.id] || 0) + cluster.branches.length;
                matchedCount += cluster.branches.length;
                totalEstimatedCost += cluster.branches.length * 1500;
            }
            else {
                for (const b of cluster.branches) {
                    uncoveredBranches.push({
                        branchId: b.id,
                        branchName: b.name,
                        reason: 'No eligible workforce candidate with available capacity within territorial range.',
                    });
                }
            }
            clusterAssignments.push({
                id: cluster.id,
                name: cluster.name,
                branchCount: cluster.branches.length,
                assignedAssayerName,
            });
        }
        const totalBranchesCount = activeBranches.length;
        const coveragePercentage = totalBranchesCount > 0 ? parseFloat(((matchedCount / totalBranchesCount) * 100).toFixed(1)) : 0;
        let confidenceScore = 100;
        if (coveragePercentage < 80)
            confidenceScore -= 30;
        if (uncoveredBranches.length > 0)
            confidenceScore -= 10;
        if (activeAssayers.length === 0)
            confidenceScore -= 50;
        if (coveragePercentage < 90) {
            warnings.push({
                type: 'COVERAGE_GAP',
                message: `Project coverage is suboptimal (${coveragePercentage}%). Five or more branches cannot be matching automatically.`,
            });
        }
        const currentAssignmentsCount = Object.values(allocationMap).reduce((acc, curr) => acc + curr, 0);
        const avgWorkloadRatio = activeAssayers.length > 0 ? currentAssignmentsCount / activeAssayers.length : 0;
        if (avgWorkloadRatio > 10) {
            warnings.push({
                type: 'CAPACITY_WARNING',
                message: 'High overall workforce load; tight margins could result in schedule delays.',
            });
            confidenceScore -= 15;
        }
        return {
            projectId,
            projectName: project.name,
            coveragePercentage,
            estimatedDurationDays: Math.ceil(totalBranchesCount / 4) || 1,
            estimatedOperationalCost: totalEstimatedCost,
            requiredWorkforceCount: assignedAssayerIds.size,
            availableWorkforceCount: activeAssayers.length,
            confidenceScore: Math.max(0, confidenceScore),
            uncoveredBranches,
            warnings,
            workforceCapacity,
            clusters: clusterAssignments,
        };
    }
};
exports.CoveragePlanningEngine = CoveragePlanningEngine;
exports.CoveragePlanningEngine = CoveragePlanningEngine = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Inject)('PlanningBranchProvider')),
    __param(5, (0, common_1.Inject)('AssayerAvailabilityProvider')),
    __param(6, (0, common_1.Inject)('WorkloadProvider')),
    __metadata("design:paramtypes", [project_query_service_1.ProjectQueryService,
        recommendation_engine_1.RecommendationEngine,
        constraint_evaluator_1.ConstraintEvaluator,
        cluster_manager_1.ClusterManager, Object, Object, Object])
], CoveragePlanningEngine);
//# sourceMappingURL=coverage-planning.engine.js.map