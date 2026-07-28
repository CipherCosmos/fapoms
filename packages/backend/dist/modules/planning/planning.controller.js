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
exports.PlanningController = exports.UpdateBusinessRuleRequestDto = exports.CreateBusinessRuleRequestDto = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const planning_service_1 = require("./planning.service");
const planning_orchestrator_service_1 = require("./planning-orchestrator.service");
const project_planning_service_1 = require("./project-planning.service");
const optimization_engine_1 = require("./optimization.engine");
const scenario_planning_service_1 = require("./scenario-planning.service");
const coverage_planning_engine_1 = require("./coverage-planning.engine");
const day_planner_service_1 = require("./day-planner.service");
const operations_planning_service_1 = require("./operations-planning.service");
const operations_control_center_service_1 = require("./operations-control-center.service");
const operations_execution_service_1 = require("./operations-execution.service");
const field_operations_service_1 = require("./field-operations.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateBusinessRuleRequestDto {
    name;
    scope;
    targetId;
    ruleType;
    conditions;
    actions;
}
exports.CreateBusinessRuleRequestDto = CreateBusinessRuleRequestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBusinessRuleRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBusinessRuleRequestDto.prototype, "scope", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateBusinessRuleRequestDto.prototype, "targetId", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateBusinessRuleRequestDto.prototype, "ruleType", void 0);
__decorate([
    (0, class_validator_1.IsObject)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", Object)
], CreateBusinessRuleRequestDto.prototype, "conditions", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], CreateBusinessRuleRequestDto.prototype, "actions", void 0);
class UpdateBusinessRuleRequestDto {
    name;
    scope;
    targetId;
    ruleType;
    conditions;
    actions;
}
exports.UpdateBusinessRuleRequestDto = UpdateBusinessRuleRequestDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateBusinessRuleRequestDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateBusinessRuleRequestDto.prototype, "scope", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", Object)
], UpdateBusinessRuleRequestDto.prototype, "targetId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], UpdateBusinessRuleRequestDto.prototype, "ruleType", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateBusinessRuleRequestDto.prototype, "conditions", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], UpdateBusinessRuleRequestDto.prototype, "actions", void 0);
let PlanningController = class PlanningController {
    planningService;
    planningOrchestratorService;
    projectPlanningService;
    optimizationEngine;
    scenarioPlanningService;
    coveragePlanningEngine;
    operationsPlanningService;
    controlCenterService;
    executionService;
    fieldService;
    dayPlannerService;
    constructor(planningService, planningOrchestratorService, projectPlanningService, optimizationEngine, scenarioPlanningService, coveragePlanningEngine, operationsPlanningService, controlCenterService, executionService, fieldService, dayPlannerService) {
        this.planningService = planningService;
        this.planningOrchestratorService = planningOrchestratorService;
        this.projectPlanningService = projectPlanningService;
        this.optimizationEngine = optimizationEngine;
        this.scenarioPlanningService = scenarioPlanningService;
        this.coveragePlanningEngine = coveragePlanningEngine;
        this.operationsPlanningService = operationsPlanningService;
        this.controlCenterService = controlCenterService;
        this.executionService = executionService;
        this.fieldService = fieldService;
        this.dayPlannerService = dayPlannerService;
    }
    async createVisit(body) {
        const visit = await this.fieldService.createFieldVisit(body.coveragePlanId, body.executionGroupId, body.branchId, body.assayerId, body.plannedDate);
        return {
            success: true,
            data: visit,
        };
    }
    async transitionVisit(visitId, body) {
        const visit = await this.fieldService.transitionVisitStatus(visitId, body.status);
        return {
            success: true,
            data: visit,
        };
    }
    async reportIncident(visitId, body) {
        const incident = await this.fieldService.reportIncident(visitId, body.title, body.description, body.severity);
        return {
            success: true,
            data: incident,
        };
    }
    async resolveIncident(incidentId, body) {
        const incident = await this.fieldService.resolveIncident(incidentId, body.justification);
        return {
            success: true,
            data: incident,
        };
    }
    async getHandover(visitId) {
        const pkg = await this.fieldService.generateHandoverPackage(visitId);
        return {
            success: true,
            data: pkg,
        };
    }
    async getFieldDashboard(coveragePlanId) {
        const summary = await this.fieldService.getFieldOperationsDashboard(coveragePlanId);
        return {
            success: true,
            data: summary,
        };
    }
    async packageAssignments(dto) {
        const pkg = await this.executionService.packageAssignments(dto);
        return {
            success: true,
            data: pkg,
        };
    }
    async postMessage(groupId, body) {
        const msg = await this.executionService.postConversationMessage(groupId, body.sender, body.message, body.feeOverride, body.dateOverride);
        return {
            success: true,
            data: msg,
        };
    }
    async getReadiness(groupId) {
        const audit = await this.executionService.evaluateOperationalReadiness(groupId);
        return {
            success: true,
            data: audit,
        };
    }
    async getControlCenterDashboard() {
        const summary = await this.controlCenterService.getDashboardSummary();
        return {
            success: true,
            data: summary,
        };
    }
    async createTask(body) {
        const task = await this.controlCenterService.createOperationsTask(body.projectId, body.title, body.reason, body.priority);
        return {
            success: true,
            data: task,
        };
    }
    async resolveTask(taskId, body) {
        const task = await this.controlCenterService.resolveOperationsTask(taskId, body.justification);
        return {
            success: true,
            data: task,
        };
    }
    async createException(body) {
        const exc = await this.controlCenterService.flagException(body.projectId, body.category, body.message, body.targetEntityId);
        return {
            success: true,
            data: exc,
        };
    }
    async resolveException(exceptionId, body) {
        const exc = await this.controlCenterService.resolveException(exceptionId, body.justification);
        return {
            success: true,
            data: exc,
        };
    }
    async getProjectCoverage(projectId) {
        const coverage = await this.planningOrchestratorService.getProjectCoverage(projectId);
        return {
            success: true,
            data: coverage,
        };
    }
    async getProjectCoveragePlan(projectId) {
        const plan = await this.coveragePlanningEngine.generateCoveragePlan(projectId);
        return {
            success: true,
            data: plan,
        };
    }
    async createOrRegeneratePlan(projectId, body, req) {
        const plan = await this.operationsPlanningService.createOrRegeneratePlan(projectId, body.overrides || [], req.user.id, body.justification);
        return {
            success: true,
            data: plan,
        };
    }
    async transitionPlan(planId, body, req) {
        const plan = await this.operationsPlanningService.transitionPlanStatus(planId, body.status, req.user.id);
        return {
            success: true,
            data: plan,
        };
    }
    async executePlan(planId, req) {
        await this.operationsPlanningService.executeApprovedPlan(planId, req.user.id);
        return {
            success: true,
            data: { message: 'Approved coverage plan executed and deployed successfully.' },
        };
    }
    async getProjectCandidates(projectId) {
        const report = await this.projectPlanningService.getProjectPlanningCandidates(projectId);
        return {
            success: true,
            data: report,
        };
    }
    async optimizeProjectDeployment(projectId) {
        const plan = await this.optimizationEngine.generateProjectDeploymentPlan(projectId);
        return {
            success: true,
            data: plan,
        };
    }
    async simulateScenario(dto) {
        const plan = await this.scenarioPlanningService.simulatePlanningScenario(dto);
        return {
            success: true,
            data: plan,
        };
    }
    async getRecommendations(branchId) {
        const recommendations = await this.planningService.getRecommendedCandidates(branchId);
        return {
            success: true,
            data: recommendations,
        };
    }
    async getDayPlans(projectId, targetDate) {
        const plan = await this.dayPlannerService.generateDayPlans(projectId, targetDate);
        return {
            success: true,
            data: plan,
        };
    }
    async createRule(dto, req) {
        const rule = await this.planningService.createRule(dto, req.user.id);
        return {
            success: true,
            data: rule,
        };
    }
    async updateRule(id, dto, req) {
        const rule = await this.planningService.updateRule(id, dto, req.user.id);
        return {
            success: true,
            data: rule,
        };
    }
    async deleteRule(id, req) {
        await this.planningService.deleteRule(id, req.user.id);
        return {
            success: true,
            data: { message: 'Business rule deleted successfully' },
        };
    }
    async getRules(scope) {
        const rules = await this.planningService.getRules(scope);
        return {
            success: true,
            data: rules,
        };
    }
    async getRule(id) {
        const rule = await this.planningService.getRule(id);
        return {
            success: true,
            data: rule,
        };
    }
};
exports.PlanningController = PlanningController;
__decorate([
    (0, common_1.Post)('field/visits'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Initialize new field visit execution record' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "createVisit", null);
__decorate([
    (0, common_1.Put)('field/visits/:visitId/status'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, guards_1.RequirePermissions)('planning:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Transition field visit execution status (e.g. READY to TRAVELLING)' }),
    __param(0, (0, common_1.Param)('visitId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "transitionVisit", null);
__decorate([
    (0, common_1.Post)('field/visits/:visitId/incidents'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Report operational field incident (e.g. branch closed, assayer illness)' }),
    __param(0, (0, common_1.Param)('visitId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "reportIncident", null);
__decorate([
    (0, common_1.Put)('field/incidents/:incidentId/resolve'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Resolve active field incident' }),
    __param(0, (0, common_1.Param)('incidentId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "resolveIncident", null);
__decorate([
    (0, common_1.Get)('field/visits/:visitId/handover'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Generate handover package validation contract for OCR processing' }),
    __param(0, (0, common_1.Param)('visitId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getHandover", null);
__decorate([
    (0, common_1.Get)('field/dashboards/:coveragePlanId'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Get Field Execution dashboard stats summary' }),
    __param(0, (0, common_1.Param)('coveragePlanId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getFieldDashboard", null);
__decorate([
    (0, common_1.Post)('execution/packages'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Bundle multiple operational assignments into a single deployment package' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "packageAssignments", null);
__decorate([
    (0, common_1.Post)('execution/packages/:groupId/conversations'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Record conversation message with fee/date negotiations' }),
    __param(0, (0, common_1.Param)('groupId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "postMessage", null);
__decorate([
    (0, common_1.Get)('execution/packages/:groupId/readiness'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Audit operational readiness constraints of a deployment package' }),
    __param(0, (0, common_1.Param)('groupId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getReadiness", null);
__decorate([
    (0, common_1.Get)('control-center/dashboard'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Get live Control Center execution statistics and KPI risk parameters' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getControlCenterDashboard", null);
__decorate([
    (0, common_1.Post)('control-center/tasks'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Generate manual operational task in the queue' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "createTask", null);
__decorate([
    (0, common_1.Put)('control-center/tasks/:taskId/resolve'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Resolve an operations task with justification log' }),
    __param(0, (0, common_1.Param)('taskId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "resolveTask", null);
__decorate([
    (0, common_1.Post)('control-center/exceptions'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Flag managed exception rule violations' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "createException", null);
__decorate([
    (0, common_1.Put)('control-center/exceptions/:exceptionId/resolve'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Resolve or bypass exception log with justification' }),
    __param(0, (0, common_1.Param)('exceptionId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "resolveException", null);
__decorate([
    (0, common_1.Get)('projects/:projectId/coverage'),
    (0, swagger_1.ApiOperation)({ summary: 'Get project planning coverage and metrics summary' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getProjectCoverage", null);
__decorate([
    (0, common_1.Get)('projects/:projectId/coverage-plan'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Generate detailed coverage planning statistics, capacity analysis, and cluster plans' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getProjectCoveragePlan", null);
__decorate([
    (0, common_1.Post)('projects/:projectId/coverage-plan'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Create or regenerate coverage plan version with manual overrides' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "createOrRegeneratePlan", null);
__decorate([
    (0, common_1.Put)('coverage-plans/:planId/transition'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Transition coverage plan lifecycle status (e.g. DRAFT to APPROVED)' }),
    __param(0, (0, common_1.Param)('planId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "transitionPlan", null);
__decorate([
    (0, common_1.Post)('coverage-plans/:planId/execute'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Deploy approved plan and automatically spawn operational assignments' }),
    __param(0, (0, common_1.Param)('planId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "executePlan", null);
__decorate([
    (0, common_1.Get)('projects/:projectId/candidates'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Retrieve candidates for all unassigned branches of a project' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getProjectCandidates", null);
__decorate([
    (0, common_1.Post)('projects/:projectId/optimize'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Generate optimized project-wide assayer matching and routing deployment plan' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "optimizeProjectDeployment", null);
__decorate([
    (0, common_1.Post)('scenarios/simulate'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Simulate planning scenario with weight and config overrides without mutating database' }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "simulateScenario", null);
__decorate([
    (0, common_1.Get)('recommendations'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Retrieve and rank candidate assayers for a branch' }),
    __param(0, (0, common_1.Query)('branchId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getRecommendations", null);
__decorate([
    (0, common_1.Get)('projects/:projectId/day-plans'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER, shared_1.SystemRole.OPERATIONS_EXECUTIVE),
    (0, swagger_1.ApiOperation)({ summary: 'Generate multi-branch day plans grouping nearby branches for single assayer coverage' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Query)('targetDate')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getDayPlans", null);
__decorate([
    (0, common_1.Post)('rules'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:create:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new business planning rule' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateBusinessRuleRequestDto, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "createRule", null);
__decorate([
    (0, common_1.Put)('rules/:id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
    (0, guards_1.RequirePermissions)('planning:update:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Update a business planning rule by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, UpdateBusinessRuleRequestDto, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "updateRule", null);
__decorate([
    (0, common_1.Delete)('rules/:id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, guards_1.RequirePermissions)('planning:delete:organization'),
    (0, swagger_1.ApiOperation)({ summary: 'Soft delete/disable a business planning rule' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "deleteRule", null);
__decorate([
    (0, common_1.Get)('rules'),
    (0, swagger_1.ApiOperation)({ summary: 'List all active business planning rules' }),
    __param(0, (0, common_1.Query)('scope')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getRules", null);
__decorate([
    (0, common_1.Get)('rules/:id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get a business planning rule by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getRule", null);
exports.PlanningController = PlanningController = __decorate([
    (0, swagger_1.ApiTags)('Planning'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard, guards_1.PermissionsGuard),
    (0, common_1.Controller)('planning'),
    __metadata("design:paramtypes", [planning_service_1.PlanningService,
        planning_orchestrator_service_1.PlanningOrchestratorService,
        project_planning_service_1.ProjectPlanningService,
        optimization_engine_1.OptimizationEngine,
        scenario_planning_service_1.ScenarioPlanningService,
        coverage_planning_engine_1.CoveragePlanningEngine,
        operations_planning_service_1.OperationsPlanningService,
        operations_control_center_service_1.OperationsControlCenterService,
        operations_execution_service_1.OperationsExecutionService,
        field_operations_service_1.FieldOperationsService,
        day_planner_service_1.DayPlannerService])
], PlanningController);
//# sourceMappingURL=planning.controller.js.map