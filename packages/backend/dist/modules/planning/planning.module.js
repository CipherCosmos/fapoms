"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlanningModule = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const planning_service_1 = require("./planning.service");
const planning_controller_1 = require("./planning.controller");
const planning_orchestrator_service_1 = require("./planning-orchestrator.service");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const geo_module_1 = require("../geo/geo.module");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const business_rule_entity_1 = require("../platform/rules/business-rule.entity");
const client_entity_1 = require("../client/client.entity");
const recommendation_engine_1 = require("./recommendation.engine");
let PlanningModule = class PlanningModule {
};
exports.PlanningModule = PlanningModule;
exports.PlanningModule = PlanningModule = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forFeature([
                branch_entity_1.BranchEntity,
                assayer_entity_1.AssayerEntity,
                assignment_entity_1.AssignmentEntity,
                project_branch_entity_1.ProjectBranchEntity,
                assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity,
                business_rule_entity_1.BusinessRuleEntity,
                client_entity_1.ClientEntity,
            ]),
            geo_module_1.GeoModule,
        ],
        controllers: [planning_controller_1.PlanningController],
        providers: [
            planning_service_1.PlanningService,
            planning_orchestrator_service_1.PlanningOrchestratorService,
            recommendation_engine_1.AvailabilityFilter,
            recommendation_engine_1.ClientRestrictionFilter,
            recommendation_engine_1.ClientEligibilityFilter,
            recommendation_engine_1.RuleEngineEligibilityFilter,
            recommendation_engine_1.RequiredSkillsFilter,
            recommendation_engine_1.DistanceScoreCalculator,
            recommendation_engine_1.TravelTimeScoreCalculator,
            recommendation_engine_1.WorkloadScoreCalculator,
            recommendation_engine_1.PerformanceScoreCalculator,
            recommendation_engine_1.ExperienceScoreCalculator,
            recommendation_engine_1.CostScoreCalculator,
            recommendation_engine_1.ClientPreferenceScoreCalculator,
            recommendation_engine_1.BranchFamiliarityScoreCalculator,
            recommendation_engine_1.SLAComplianceScoreCalculator,
            recommendation_engine_1.ProfitabilityScoreCalculator,
            recommendation_engine_1.RiskScoreCalculator,
            recommendation_engine_1.RecommendationEngine,
        ],
        exports: [planning_service_1.PlanningService, planning_orchestrator_service_1.PlanningOrchestratorService, recommendation_engine_1.RecommendationEngine],
    })
], PlanningModule);
//# sourceMappingURL=planning.module.js.map