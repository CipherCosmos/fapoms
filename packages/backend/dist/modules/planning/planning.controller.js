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
    constructor(planningService, planningOrchestratorService) {
        this.planningService = planningService;
        this.planningOrchestratorService = planningOrchestratorService;
    }
    async getProjectCoverage(projectId) {
        const coverage = await this.planningOrchestratorService.getProjectCoverage(projectId);
        return {
            success: true,
            data: coverage,
        };
    }
    async getRecommendations(branchId) {
        const recommendations = await this.planningService.getRecommendedCandidates(branchId);
        return {
            success: true,
            data: recommendations,
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
    (0, common_1.Get)('projects/:projectId/coverage'),
    (0, swagger_1.ApiOperation)({ summary: 'Get project planning coverage and metrics summary' }),
    __param(0, (0, common_1.Param)('projectId', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], PlanningController.prototype, "getProjectCoverage", null);
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
    (0, common_1.Post)('rules'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR, shared_1.SystemRole.OPERATIONS_MANAGER),
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
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    (0, common_1.Controller)('planning'),
    __metadata("design:paramtypes", [planning_service_1.PlanningService,
        planning_orchestrator_service_1.PlanningOrchestratorService])
], PlanningController);
//# sourceMappingURL=planning.controller.js.map