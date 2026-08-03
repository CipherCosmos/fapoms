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
const command_center_service_1 = require("./command-center.service");
const planning_service_1 = require("./planning.service");
const planning_controller_1 = require("./planning.controller");
const planning_orchestrator_service_1 = require("./planning-orchestrator.service");
const project_planning_service_1 = require("./project-planning.service");
const optimization_engine_1 = require("./optimization.engine");
const scenario_planning_service_1 = require("./scenario-planning.service");
const cluster_manager_1 = require("./cluster.manager");
const coverage_planning_engine_1 = require("./coverage-planning.engine");
const operations_planning_service_1 = require("./operations-planning.service");
const operations_control_center_service_1 = require("./operations-control-center.service");
const operations_execution_service_1 = require("./operations-execution.service");
const field_operations_service_1 = require("./field-operations.service");
const day_planner_service_1 = require("./day-planner.service");
const planning_acl_adapter_1 = require("./planning-acl.adapter");
const operations_acl_adapter_1 = require("./operations-acl.adapter");
const operations_project_metrics_adapter_1 = require("./operations-project-metrics.adapter");
const coverage_plan_entity_1 = require("./coverage-plan.entity");
const coverage_plan_version_entity_1 = require("./coverage-plan-version.entity");
const operations_task_entity_1 = require("./operations-task.entity");
const operations_exception_entity_1 = require("./operations-exception.entity");
const operations_execution_group_entity_1 = require("./operations-execution-group.entity");
const operations_execution_conversation_entity_1 = require("./operations-execution-conversation.entity");
const field_visit_entity_1 = require("./field-visit.entity");
const field_incident_entity_1 = require("./field-incident.entity");
const branch_entity_1 = require("../branch/branch.entity");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const schedule_entity_1 = require("../scheduling/schedule.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const project_entity_1 = require("../project/project.entity");
const geo_module_1 = require("../geo/geo.module");
const branch_module_1 = require("../branch/branch.module");
const assayer_module_1 = require("../assayer/assayer.module");
const holiday_module_1 = require("../holiday/holiday.module");
const project_module_1 = require("../project/project.module");
const assignment_module_1 = require("../assignment/assignment.module");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const business_rule_entity_1 = require("../platform/rules/business-rule.entity");
const client_entity_1 = require("../client/client.entity");
const constraint_evaluator_1 = require("./constraint.evaluator");
const recommendation_engine_1 = require("./recommendation.engine");
const validation_query_entity_1 = require("../validation-query/validation-query.entity");
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
                validation_query_entity_1.ValidationQueryEntity,
                schedule_entity_1.ScheduleEntity,
                project_branch_entity_1.ProjectBranchEntity,
                project_entity_1.ProjectEntity,
                assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity,
                business_rule_entity_1.BusinessRuleEntity,
                client_entity_1.ClientEntity,
                coverage_plan_entity_1.CoveragePlanEntity,
                coverage_plan_version_entity_1.CoveragePlanVersionEntity,
                operations_task_entity_1.OperationsTaskEntity,
                operations_exception_entity_1.OperationsExceptionEntity,
                operations_execution_group_entity_1.OperationsExecutionGroupEntity,
                operations_execution_conversation_entity_1.OperationsExecutionConversationEntity,
                field_visit_entity_1.FieldVisitEntity,
                field_incident_entity_1.FieldIncidentEntity,
            ]),
            geo_module_1.GeoModule,
            branch_module_1.BranchModule,
            assayer_module_1.AssayerModule,
            holiday_module_1.HolidayModule,
            project_module_1.ProjectModule,
            (0, common_1.forwardRef)(() => assignment_module_1.AssignmentModule),
        ],
        controllers: [planning_controller_1.PlanningController],
        providers: [
            planning_service_1.PlanningService,
            command_center_service_1.CommandCenterService,
            planning_orchestrator_service_1.PlanningOrchestratorService,
            project_planning_service_1.ProjectPlanningService,
            optimization_engine_1.OptimizationEngine,
            scenario_planning_service_1.ScenarioPlanningService,
            cluster_manager_1.ClusterManager,
            coverage_planning_engine_1.CoveragePlanningEngine,
            operations_planning_service_1.OperationsPlanningService,
            operations_control_center_service_1.OperationsControlCenterService,
            operations_execution_service_1.OperationsExecutionService,
            field_operations_service_1.FieldOperationsService,
            day_planner_service_1.DayPlannerService,
            constraint_evaluator_1.ConstraintEvaluator,
            planning_acl_adapter_1.PlanningAntiCorruptionLayer,
            operations_acl_adapter_1.OperationsAntiCorruptionLayer,
            operations_project_metrics_adapter_1.OperationsProjectMetricsAdapter,
            { provide: 'ProjectMetricsProvider', useClass: operations_project_metrics_adapter_1.OperationsProjectMetricsAdapter },
            { provide: 'PlanningBranchProvider', useClass: planning_acl_adapter_1.PlanningAntiCorruptionLayer },
            { provide: 'AssayerAvailabilityProvider', useClass: planning_acl_adapter_1.PlanningAntiCorruptionLayer },
            { provide: 'WorkloadProvider', useClass: planning_acl_adapter_1.PlanningAntiCorruptionLayer },
            { provide: 'OperationsControlServiceInterface', useClass: operations_planning_service_1.OperationsPlanningService },
            recommendation_engine_1.AvailabilityFilter,
            recommendation_engine_1.ConsecutiveBranchAuditFilter,
            recommendation_engine_1.ClientRestrictionFilter,
            recommendation_engine_1.ClientEligibilityFilter,
            recommendation_engine_1.RuleEngineEligibilityFilter,
            recommendation_engine_1.RequiredSkillsFilter,
            recommendation_engine_1.DistanceScoreCalculator,
            recommendation_engine_1.TravelTimeScoreCalculator,
            recommendation_engine_1.WorkloadScoreCalculator,
            recommendation_engine_1.PerformanceScoreCalculator,
            recommendation_engine_1.RejectionAcceptanceScoreCalculator,
            recommendation_engine_1.DeliverySpeedScoreCalculator,
            recommendation_engine_1.QueryVolumeScoreCalculator,
            recommendation_engine_1.ExperienceScoreCalculator,
            recommendation_engine_1.CostScoreCalculator,
            recommendation_engine_1.ClientPreferenceScoreCalculator,
            recommendation_engine_1.BranchFamiliarityScoreCalculator,
            recommendation_engine_1.SLAComplianceScoreCalculator,
            recommendation_engine_1.CustomerDensityScoreCalculator,
            recommendation_engine_1.ProfitabilityScoreCalculator,
            recommendation_engine_1.RiskScoreCalculator,
            recommendation_engine_1.RecommendationEngine,
        ],
        exports: [planning_service_1.PlanningService, planning_orchestrator_service_1.PlanningOrchestratorService, project_planning_service_1.ProjectPlanningService, optimization_engine_1.OptimizationEngine, scenario_planning_service_1.ScenarioPlanningService, cluster_manager_1.ClusterManager, coverage_planning_engine_1.CoveragePlanningEngine, operations_planning_service_1.OperationsPlanningService, 'OperationsControlServiceInterface', operations_control_center_service_1.OperationsControlCenterService, operations_execution_service_1.OperationsExecutionService, field_operations_service_1.FieldOperationsService, recommendation_engine_1.RecommendationEngine, constraint_evaluator_1.ConstraintEvaluator, day_planner_service_1.DayPlannerService],
    })
], PlanningModule);
//# sourceMappingURL=planning.module.js.map