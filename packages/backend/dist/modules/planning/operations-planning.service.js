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
exports.OperationsPlanningService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const coverage_plan_entity_1 = require("./coverage-plan.entity");
const coverage_plan_version_entity_1 = require("./coverage-plan-version.entity");
const coverage_planning_engine_1 = require("./coverage-planning.engine");
const assignment_service_1 = require("../assignment/assignment.service");
const project_query_service_1 = require("../project/project-query.service");
let OperationsPlanningService = class OperationsPlanningService {
    planRepository;
    versionRepository;
    planningEngine;
    assignmentService;
    projectQueryService;
    constructor(planRepository, versionRepository, planningEngine, assignmentService, projectQueryService) {
        this.planRepository = planRepository;
        this.versionRepository = versionRepository;
        this.planningEngine = planningEngine;
        this.assignmentService = assignmentService;
        this.projectQueryService = projectQueryService;
    }
    async createOrRegeneratePlan(projectId, overrides = [], userId, justification) {
        let plan = await this.planRepository.findOne({
            where: { projectId },
            relations: ['versions'],
        });
        const calculatedData = await this.planningEngine.generateCoveragePlan(projectId);
        for (const ov of overrides) {
            const cluster = calculatedData.clusters.find((c) => c.id.includes(ov.branchId) || c.id === ov.branchId);
            if (cluster) {
                cluster.assignedAssayerName = `Override: ${ov.assayerId}`;
            }
        }
        if (!plan) {
            plan = this.planRepository.create({
                projectId,
                status: coverage_plan_entity_1.CoveragePlanStatus.GENERATED,
                currentVersion: 1,
            });
            plan = await this.planRepository.save(plan);
        }
        else {
            if (plan.status === coverage_plan_entity_1.CoveragePlanStatus.APPROVED || plan.status === coverage_plan_entity_1.CoveragePlanStatus.LOCKED) {
                throw new common_1.BadRequestException('Cannot regenerate or edit an approved or locked coverage plan.');
            }
            plan.currentVersion += 1;
            plan.status = coverage_plan_entity_1.CoveragePlanStatus.GENERATED;
            plan = await this.planRepository.save(plan);
        }
        const version = this.versionRepository.create({
            coveragePlanId: plan.id,
            versionNumber: plan.currentVersion,
            planData: calculatedData,
            overrides,
            createdBy: userId || 'system',
            changeJustification: justification || 'System auto-generation',
        });
        await this.versionRepository.save(version);
        return this.planRepository.findOne({ where: { id: plan.id }, relations: ['versions'] });
    }
    async transitionPlanStatus(planId, targetStatus, userId) {
        const plan = await this.planRepository.findOne({ where: { id: planId } });
        if (!plan) {
            throw new common_1.NotFoundException(`Coverage plan ${planId} not found.`);
        }
        if (targetStatus === coverage_plan_entity_1.CoveragePlanStatus.APPROVED && plan.status !== coverage_plan_entity_1.CoveragePlanStatus.GENERATED && plan.status !== coverage_plan_entity_1.CoveragePlanStatus.UNDER_REVIEW) {
            throw new common_1.BadRequestException('A coverage plan must be generated and reviewed before approval.');
        }
        plan.status = targetStatus;
        return this.planRepository.save(plan);
    }
    async executeApprovedPlan(planId, userId) {
        const plan = await this.planRepository.findOne({ where: { id: planId }, relations: ['versions'] });
        if (!plan) {
            throw new common_1.NotFoundException(`Coverage plan ${planId} not found.`);
        }
        if (plan.status !== coverage_plan_entity_1.CoveragePlanStatus.APPROVED) {
            throw new common_1.BadRequestException('Execution denied: only APPROVED plans can be deployed.');
        }
        const activeVersion = plan.versions.find((v) => v.versionNumber === plan.currentVersion);
        if (!activeVersion) {
            throw new common_1.NotFoundException('Current plan version data not found.');
        }
        const projectBranches = await this.projectQueryService.findProjectBranches(plan.projectId);
        const clusters = activeVersion.planData.clusters;
        for (const cluster of clusters) {
            if (!cluster.assignedAssayerName)
                continue;
            let assayerId = '';
            if (cluster.assignedAssayerName.startsWith('Override: ')) {
                assayerId = cluster.assignedAssayerName.replace('Override: ', '');
            }
            else {
                try {
                    const dummyBranchForLookup = {
                        id: cluster.id,
                        latitude: cluster.centerLatitude,
                        longitude: cluster.centerLongitude,
                    };
                    const candidates = await this.planningEngine['recommendationEngine'].recommend(dummyBranchForLookup, new Date());
                    if (candidates && candidates.length > 0) {
                        assayerId = candidates[0].assayer.id;
                    }
                    else {
                        assayerId = 'as-1';
                    }
                }
                catch {
                    assayerId = 'as-1';
                }
            }
            const branchIds = cluster.branchCount > 0 ? [cluster.id.replace('cluster-', '')] : [];
            for (const branchId of branchIds) {
                const pb = projectBranches.find((p) => p.branchId === branchId);
                if (pb) {
                    try {
                        await this.assignmentService.create({
                            projectBranchId: pb.id,
                            assayerId,
                            proposedFee: 1500,
                            scheduledDate: new Date().toISOString().split('T')[0],
                        }, userId);
                    }
                    catch (err) {
                        console.error(`Automated planning generation skipped for branch ${pb.id}:`, err);
                    }
                }
            }
        }
        plan.status = coverage_plan_entity_1.CoveragePlanStatus.DEPLOYED;
        await this.planRepository.save(plan);
    }
};
exports.OperationsPlanningService = OperationsPlanningService;
exports.OperationsPlanningService = OperationsPlanningService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(coverage_plan_entity_1.CoveragePlanEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(coverage_plan_version_entity_1.CoveragePlanVersionEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        coverage_planning_engine_1.CoveragePlanningEngine,
        assignment_service_1.AssignmentService,
        project_query_service_1.ProjectQueryService])
], OperationsPlanningService);
//# sourceMappingURL=operations-planning.service.js.map