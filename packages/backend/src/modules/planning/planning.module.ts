/**
 * FAPOMS — Planning Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
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
import { DayPlannerService } from './day-planner.service';
import { PlanningJobsService } from './planning-jobs.service';
import { PlanningJobsWorker } from './planning-jobs.worker';
import { PLANNING_QUEUE } from './planning-jobs.contract';
import { PlanningAntiCorruptionLayer } from './planning-acl.adapter';
import { OperationsAntiCorruptionLayer } from './operations-acl.adapter';
import { OperationsProjectMetricsAdapter } from './operations-project-metrics.adapter';
import { CoveragePlanEntity } from './coverage-plan.entity';
import { CoveragePlanVersionEntity } from './coverage-plan-version.entity';
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
  RemarksScoreCalculator,
  FairnessScoreCalculator,
  RecommendationEngine,
} from './recommendation.engine';

import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
// The remarks scorer reads staff remarks through the module that owns them.
import { AssayerRemarksModule } from '../assayer-remarks/assayer-remarks.module';

@Module({
  imports: [
    PricingModule,
    /**
     * Planning's own queue, deliberately not the shared 'background-jobs' one.
     *
     * Two reasons. First, isolation: a coverage plan holds its worker for seconds, and sharing a
     * queue with short operational jobs (document dispatch, notification delivery) would put
     * those behind it. Second, and more immediately, 'background-jobs' does not currently
     * deliver anything — `BullQueueManager` adds *named* jobs while `BullProcessor` declares a
     * bare `@Process()`, which in Bull only ever matches unnamed jobs, so everything routed
     * through it stalls. `PlanningJobsWorker` names its handlers from the same constants the
     * enqueue side uses, which is what stops that from recurring here.
     *
     * `BullModule.forRoot` (Redis connection) is configured once in app.module.ts and applies to
     * every queue registered anywhere, so nothing outside this module needs to change.
     */
    BullModule.registerQueue({ name: PLANNING_QUEUE }),
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
    ]),
    GeoModule,
    BranchModule,
    AssayerModule,
    HolidayModule,
    ProjectModule,
    NotificationsModule,
    forwardRef(() => AssignmentModule),
    AssayerRemarksModule,
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
    DayPlannerService,
    PlanningJobsService,
    PlanningJobsWorker,
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
    RemarksScoreCalculator,
    FairnessScoreCalculator,
    RecommendationEngine,
  ],
  exports: [PlanningService, PlanningOrchestratorService, ProjectPlanningService, OptimizationEngine, ScenarioPlanningService, ClusterManager, CoveragePlanningEngine, OperationsPlanningService, 'OperationsControlServiceInterface', RecommendationEngine, ConstraintEvaluator, DayPlannerService, CommandCenterService],
})
export class PlanningModule {}

