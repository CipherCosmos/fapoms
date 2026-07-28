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
exports.ProjectPlanningService = void 0;
const common_1 = require("@nestjs/common");
const project_query_service_1 = require("../project/project-query.service");
const planning_service_1 = require("./planning.service");
let ProjectPlanningService = class ProjectPlanningService {
    projectQueryService;
    planningService;
    constructor(projectQueryService, planningService) {
        this.projectQueryService = projectQueryService;
        this.planningService = planningService;
    }
    async getProjectPlanningCandidates(projectId) {
        const project = await this.projectQueryService.findOne(projectId);
        if (!project) {
            throw new common_1.NotFoundException(`Project ${projectId} not found.`);
        }
        const projectBranches = await this.projectQueryService.findProjectBranches(projectId);
        const unassignedPBs = projectBranches.filter((pb) => pb.status === 'IMPORTED' || pb.status === 'PLANNING' || pb.status === 'CANDIDATE_SEARCH');
        const branchCandidatesList = [];
        for (const pb of unassignedPBs) {
            let candidates = [];
            try {
                candidates = await this.planningService.getRecommendedCandidates(pb.branchId);
            }
            catch (err) {
                console.error(`Failed to load candidates for branch ${pb.branchId}:`, err);
            }
            branchCandidatesList.push({
                projectBranchId: pb.id,
                branchId: pb.branchId,
                branchCode: pb.branch.branchCode,
                branchName: pb.branch.name,
                city: pb.branch.city,
                state: pb.branch.state,
                candidates,
            });
        }
        return {
            projectId: project.id,
            projectName: project.name,
            projectNumber: project.projectNumber,
            totalUnassignedBranches: unassignedPBs.length,
            branches: branchCandidatesList,
        };
    }
};
exports.ProjectPlanningService = ProjectPlanningService;
exports.ProjectPlanningService = ProjectPlanningService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [project_query_service_1.ProjectQueryService,
        planning_service_1.PlanningService])
], ProjectPlanningService);
//# sourceMappingURL=project-planning.service.js.map