/**
 * FAPOMS — Planning Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommandCenterService } from './command-center.service';
import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectPlanningService } from './project-planning.service';
import { OptimizationEngine } from './optimization.engine';
import { ScenarioPlanningService } from './scenario-planning.service';
import { ClusterManager } from './cluster.manager';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { OperationsPlanningService } from './operations-planning.service';
import { OperationsControlCenterService } from './operations-control-center.service';
import { OperationsExecutionService } from './operations-execution.service';
import { FieldOperationsService } from './field-operations.service';
import { DayPlannerService } from './day-planner.service';
import { PlanningAntiCorruptionLayer } from './planning-acl.adapter';
import { OperationsAntiCorruptionLayer } from './operations-acl.adapter';
import { OperationsProjectMetricsAdapter } from './operations-project-metrics.adapter';
import { CoveragePlanEntity } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
import { OperationsTaskEntity } from './operations-task.entity';
import { OperationsExceptionEntity } from './operations-exception.entity';
import { OperationsExecutionGroupEntity } from './operations-execution-group.entity';
import { OperationsExecutionConversationEntity } from './operations-execution-conversation.entity';
import { FieldVisitEntity } from './field-visit.entity';
import { FieldIncidentEntity } from './field-incident.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { GeoModule } from '../geo/geo.module';
import { BranchModule } from '../branch/branch.module';
import { AssayerModule } from '../assayer/assayer.module';
import { HolidayModule } from '../holiday/holiday.module';
import { ProjectModule } from '../project/project.module';
import { AssignmentModule } from '../assignment/assignment.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { ClientEntity } from '../client/client.entity';
import { ConstraintEvaluator } from './constraint.evaluator';
import {
  DeployabilityFilter,
  AvailabilityFilter,
  ConsecutiveBranchAuditFilter,
  ClientRestrictionFilter,
  ClientEligibilityFilter,
  RuleEngineEligibilityFilter,
  RequiredSkillsFilter,
  DistancePolicyFilter,
  DistanceScoreCalculator,
  TravelTimeScoreCalculator,
  WorkloadScoreCalculator,
  PerformanceScoreCalculator,
  RejectionAcceptanceScoreCalculator,
  DeliverySpeedScoreCalculator,
  QueryVolumeScoreCalculator,
  ExperienceScoreCalculator,
  CostScoreCalculator,
  ClientPreferenceScoreCalculator,
  BranchFamiliarityScoreCalculator,
  SLAComplianceScoreCalculator,
  CustomerDensityScoreCalculator,
  ProfitabilityScoreCalculator,
  RiskScoreCalculator,
  RecommendationEngine,
} from './recommendation.engine';

import { ValidationQueryEntity } from '../validation-query/validation-query.entity';

@Module({
  imports: [
    PricingModule,
    TypeOrmModule.forFeature([
      BranchEntity,
      AssayerEntity,
      AssignmentEntity,
      ValidationQueryEntity,
      ScheduleEntity,
      ProjectBranchEntity,
      ProjectEntity,
      AssayerCommercialProfileEntity,
      BusinessRuleEntity,
      ClientEntity,
      CoveragePlanEntity,
      CoveragePlanVersionEntity,
      OperationsTaskEntity,
      OperationsExceptionEntity,
      OperationsExecutionGroupEntity,
      OperationsExecutionConversationEntity,
      FieldVisitEntity,
      FieldIncidentEntity,
    ]),
    GeoModule,
    BranchModule,
    AssayerModule,
    HolidayModule,
    ProjectModule,
    // Field incidents have to reach the operations desk — see FieldOperationsService.
    NotificationsModule,
    forwardRef(() => AssignmentModule),
  ],
  controllers: [PlanningController],
  providers: [
    PlanningService,
    CommandCenterService,
    PlanningOrchestratorService,
    ProjectPlanningService,
    OptimizationEngine,
    ScenarioPlanningService,
    ClusterManager,
    CoveragePlanningEngine,
    OperationsPlanningService,
    OperationsControlCenterService,
    OperationsExecutionService,
    FieldOperationsService,
    DayPlannerService,
    ConstraintEvaluator,
    PlanningAntiCorruptionLayer,
    OperationsAntiCorruptionLayer,
    OperationsProjectMetricsAdapter,
    { provide: 'ProjectMetricsProvider', useClass: OperationsProjectMetricsAdapter },
    { provide: 'PlanningBranchProvider', useClass: PlanningAntiCorruptionLayer },
    { provide: 'AssayerAvailabilityProvider', useClass: PlanningAntiCorruptionLayer },
    { provide: 'WorkloadProvider', useClass: PlanningAntiCorruptionLayer },
    { provide: 'OperationsControlServiceInterface', useClass: OperationsPlanningService },
    DeployabilityFilter,
    AvailabilityFilter,
    ConsecutiveBranchAuditFilter,
    ClientRestrictionFilter,
    ClientEligibilityFilter,
    RuleEngineEligibilityFilter,
    RequiredSkillsFilter,
    DistancePolicyFilter,
    DistanceScoreCalculator,
    TravelTimeScoreCalculator,
    WorkloadScoreCalculator,
    PerformanceScoreCalculator,
    RejectionAcceptanceScoreCalculator,
    DeliverySpeedScoreCalculator,
    QueryVolumeScoreCalculator,
    ExperienceScoreCalculator,
    CostScoreCalculator,
    ClientPreferenceScoreCalculator,
    BranchFamiliarityScoreCalculator,
    SLAComplianceScoreCalculator,
    CustomerDensityScoreCalculator,
    ProfitabilityScoreCalculator,
    RiskScoreCalculator,
    RecommendationEngine,
  ],
  exports: [PlanningService, PlanningOrchestratorService, ProjectPlanningService, OptimizationEngine, ScenarioPlanningService, ClusterManager, CoveragePlanningEngine, OperationsPlanningService, 'OperationsControlServiceInterface', OperationsControlCenterService, OperationsExecutionService, FieldOperationsService, RecommendationEngine, ConstraintEvaluator, DayPlannerService, CommandCenterService],
})
export class PlanningModule {}

