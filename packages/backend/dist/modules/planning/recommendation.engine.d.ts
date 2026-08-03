import { Repository } from 'typeorm';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerService } from '../assayer/assayer.service';
import { BranchEntity } from '../branch/branch.entity';
import { RoutingService } from '../geo/routing.provider';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { RuleEngine } from '../platform/rules/rule.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ConstraintEvaluator } from './constraint.evaluator';
export interface PlanningContext {
    branch: BranchEntity;
    client: ClientEntity | null;
    scheduledDate: Date;
    weights: Record<string, number>;
}
export interface CandidateFilter {
    name: string;
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export interface ScoreCalculator {
    name: string;
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class AvailabilityFilter implements CandidateFilter {
    private readonly constraintEvaluator;
    name: string;
    constructor(constraintEvaluator: ConstraintEvaluator);
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class ConsecutiveBranchAuditFilter implements CandidateFilter {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class ClientRestrictionFilter implements CandidateFilter {
    name: string;
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class ClientEligibilityFilter implements CandidateFilter {
    name: string;
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class RuleEngineEligibilityFilter implements CandidateFilter {
    private readonly ruleEngine;
    private readonly assignmentRepository;
    name: string;
    constructor(ruleEngine: RuleEngine, assignmentRepository: Repository<AssignmentEntity>);
    evaluate(assayerEntity: AssayerEntity, context: PlanningContext): Promise<boolean>;
    explain(assayerEntity: AssayerEntity, context: PlanningContext): Promise<string[]>;
}
export declare class RequiredSkillsFilter implements CandidateFilter {
    private readonly projectBranchRepository;
    private readonly constraintEvaluator;
    name: string;
    constructor(projectBranchRepository: Repository<ProjectBranchEntity>, constraintEvaluator: ConstraintEvaluator);
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class DistanceScoreCalculator implements ScoreCalculator {
    private readonly routingService;
    name: string;
    constructor(routingService: RoutingService);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class TravelTimeScoreCalculator implements ScoreCalculator {
    private readonly routingService;
    name: string;
    constructor(routingService: RoutingService);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class WorkloadScoreCalculator implements ScoreCalculator {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class PerformanceScoreCalculator implements ScoreCalculator {
    name: string;
    calculate(assayer: AssayerEntity): Promise<number>;
}
export declare class RejectionAcceptanceScoreCalculator implements ScoreCalculator {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    calculate(assayer: AssayerEntity): Promise<number>;
}
export declare class DeliverySpeedScoreCalculator implements ScoreCalculator {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    calculate(assayer: AssayerEntity): Promise<number>;
}
export declare class QueryVolumeScoreCalculator implements ScoreCalculator {
    private readonly queryRepository;
    name: string;
    constructor(queryRepository: Repository<ValidationQueryEntity>);
    calculate(assayer: AssayerEntity): Promise<number>;
}
export declare class ExperienceScoreCalculator implements ScoreCalculator {
    name: string;
    calculate(assayer: AssayerEntity): Promise<number>;
}
export declare class CostScoreCalculator implements ScoreCalculator {
    private readonly commercialRepository;
    name: string;
    constructor(commercialRepository: Repository<AssayerCommercialProfileEntity>);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class ClientPreferenceScoreCalculator implements ScoreCalculator {
    name: string;
    calculate(assayerEntity: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class BranchFamiliarityScoreCalculator implements ScoreCalculator {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class SLAComplianceScoreCalculator implements ScoreCalculator {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class CustomerDensityScoreCalculator implements ScoreCalculator {
    name: string;
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class ProfitabilityScoreCalculator implements ScoreCalculator {
    private readonly commercialRepository;
    name: string;
    constructor(commercialRepository: Repository<AssayerCommercialProfileEntity>);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class RiskScoreCalculator implements ScoreCalculator {
    name: string;
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class RecommendationEngine {
    private readonly availabilityFilter;
    private readonly consecutiveBranchAuditFilter;
    private readonly clientRestrictionFilter;
    private readonly clientEligibilityFilter;
    private readonly ruleEngineEligibilityFilter;
    private readonly requiredSkillsFilter;
    private readonly distanceCalculator;
    private readonly travelTimeCalculator;
    private readonly workloadCalculator;
    private readonly performanceCalculator;
    private readonly rejectionAcceptanceCalculator;
    private readonly deliverySpeedCalculator;
    private readonly queryVolumeCalculator;
    private readonly experienceCalculator;
    private readonly costCalculator;
    private readonly clientPreferenceCalculator;
    private readonly branchFamiliarityCalculator;
    private readonly slaComplianceCalculator;
    private readonly customerDensityCalculator;
    private readonly profitabilityCalculator;
    private readonly riskCalculator;
    private readonly configResolver;
    private readonly assayerRepository;
    private readonly clientRepository;
    private readonly assignmentRepository;
    private readonly constraintEvaluator;
    private readonly assayerService;
    private static readonly logger;
    private filters;
    private calculators;
    constructor(availabilityFilter: AvailabilityFilter, consecutiveBranchAuditFilter: ConsecutiveBranchAuditFilter, clientRestrictionFilter: ClientRestrictionFilter, clientEligibilityFilter: ClientEligibilityFilter, ruleEngineEligibilityFilter: RuleEngineEligibilityFilter, requiredSkillsFilter: RequiredSkillsFilter, distanceCalculator: DistanceScoreCalculator, travelTimeCalculator: TravelTimeScoreCalculator, workloadCalculator: WorkloadScoreCalculator, performanceCalculator: PerformanceScoreCalculator, rejectionAcceptanceCalculator: RejectionAcceptanceScoreCalculator, deliverySpeedCalculator: DeliverySpeedScoreCalculator, queryVolumeCalculator: QueryVolumeScoreCalculator, experienceCalculator: ExperienceScoreCalculator, costCalculator: CostScoreCalculator, clientPreferenceCalculator: ClientPreferenceScoreCalculator, branchFamiliarityCalculator: BranchFamiliarityScoreCalculator, slaComplianceCalculator: SLAComplianceScoreCalculator, customerDensityCalculator: CustomerDensityScoreCalculator, profitabilityCalculator: ProfitabilityScoreCalculator, riskCalculator: RiskScoreCalculator, configResolver: ConfigurationResolver, assayerRepository: Repository<AssayerEntity>, clientRepository: Repository<ClientEntity>, assignmentRepository: Repository<AssignmentEntity>, constraintEvaluator: ConstraintEvaluator, assayerService: AssayerService);
    recommend(branch: BranchEntity, scheduledDate: Date, weights?: Record<string, number>): Promise<{
        assayer: AssayerEntity;
        score: number;
        breakdown: Record<string, number>;
        pendingOnThisBranch: boolean;
    }[]>;
}
