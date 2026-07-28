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
exports.OptimizationEngine = void 0;
const common_1 = require("@nestjs/common");
const project_query_service_1 = require("../project/project-query.service");
const planning_service_1 = require("./planning.service");
let OptimizationEngine = class OptimizationEngine {
    projectQueryService;
    planningService;
    constructor(projectQueryService, planningService) {
        this.projectQueryService = projectQueryService;
        this.planningService = planningService;
    }
    async generateProjectDeploymentPlan(projectId) {
        const project = await this.projectQueryService.findOne(projectId);
        if (!project) {
            throw new common_1.NotFoundException(`Project ${projectId} not found.`);
        }
        const projectBranches = await this.projectQueryService.findProjectBranches(projectId);
        const unassignedPBs = projectBranches.filter((pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH');
        const simulatedWorkloadMap = {};
        const assignments = [];
        const unmatchedBranches = [];
        for (const pb of unassignedPBs) {
            let candidates = [];
            try {
                candidates = await this.planningService.getRecommendedCandidates(pb.branchId);
            }
            catch (err) {
                console.error(`Failed to fetch recommendations for branch ${pb.branchId}:`, err);
            }
            const validCandidates = candidates.filter((c) => {
                const capacityLimit = 15;
                const currentSimulatedLoad = simulatedWorkloadMap[c.id] || 0;
                return currentSimulatedLoad < capacityLimit && (c.score === undefined || c.score >= 30);
            });
            if (validCandidates.length > 0) {
                const bestCandidate = validCandidates[0];
                assignments.push({
                    projectBranchId: pb.id,
                    branchId: pb.branchId,
                    branchName: pb.branch.name,
                    assignedAssayerId: bestCandidate.id,
                    assignedAssayerName: bestCandidate.displayName,
                    score: bestCandidate.score || 0,
                });
                simulatedWorkloadMap[bestCandidate.id] = (simulatedWorkloadMap[bestCandidate.id] || 0) + 1;
            }
            else {
                unmatchedBranches.push({
                    projectBranchId: pb.id,
                    branchId: pb.branchId,
                    branchName: pb.branch.name,
                });
            }
        }
        return {
            projectId: project.id,
            projectName: project.name,
            totalBranchesMatched: assignments.length,
            totalBranchesUnmatched: unmatchedBranches.length,
            assignments,
            unmatchedBranches,
        };
    }
};
exports.OptimizationEngine = OptimizationEngine;
exports.OptimizationEngine = OptimizationEngine = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [project_query_service_1.ProjectQueryService,
        planning_service_1.PlanningService])
], OptimizationEngine);
//# sourceMappingURL=optimization.engine.js.map