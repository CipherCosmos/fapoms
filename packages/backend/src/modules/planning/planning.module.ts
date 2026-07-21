/**
 * FAPOMS — Planning Module
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PlanningService } from './planning.service';
import { PlanningController } from './planning.controller';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { GeoModule } from '../geo/geo.module';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { ClientEntity } from '../client/client.entity';
import {
  AvailabilityFilter,
  ClientRestrictionFilter,
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
      AssayerCommercialProfileEntity,
      BusinessRuleEntity,
      ClientEntity,
    ]),
    GeoModule,
  ],
  controllers: [PlanningController],
  providers: [
    PlanningService,
    AvailabilityFilter,
    ClientRestrictionFilter,
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
  exports: [PlanningService, RecommendationEngine],
})
export class PlanningModule {}
