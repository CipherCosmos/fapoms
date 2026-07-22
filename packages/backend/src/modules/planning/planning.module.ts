/**
 * FAPOMS — Planning Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { GeoModule } from '../geo/geo.module';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { ClientEntity } from '../client/client.entity';
import {
  AvailabilityFilter,
  ClientRestrictionFilter,
  ClientEligibilityFilter,
  RuleEngineEligibilityFilter,
  DistanceScoreCalculator,
  TravelTimeScoreCalculator,
  WorkloadScoreCalculator,
  PerformanceScoreCalculator,
  ExperienceScoreCalculator,
  CostScoreCalculator,
  ClientPreferenceScoreCalculator,
  BranchFamiliarityScoreCalculator,
  SLAComplianceScoreCalculator,
  ProfitabilityScoreCalculator,
  RiskScoreCalculator,
  RecommendationEngine,
} from './recommendation.engine';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BranchEntity,
      AssayerEntity,
      AssignmentEntity,
      ProjectBranchEntity,
      AssayerCommercialProfileEntity,
      BusinessRuleEntity,
      ClientEntity,
    ]),
    GeoModule,
  ],
  controllers: [PlanningController],
  providers: [
    PlanningService,
    PlanningOrchestratorService,
    AvailabilityFilter,
    ClientRestrictionFilter,
    ClientEligibilityFilter,
    RuleEngineEligibilityFilter,
    DistanceScoreCalculator,
    TravelTimeScoreCalculator,
    WorkloadScoreCalculator,
    PerformanceScoreCalculator,
    ExperienceScoreCalculator,
    CostScoreCalculator,
    ClientPreferenceScoreCalculator,
    BranchFamiliarityScoreCalculator,
    SLAComplianceScoreCalculator,
    ProfitabilityScoreCalculator,
    RiskScoreCalculator,
    RecommendationEngine,
  ],
  exports: [PlanningService, PlanningOrchestratorService, RecommendationEngine],
})
export class PlanningModule {}
