import { Repository } from 'typeorm';
import { AssayerEntity } from '../assayer/assayer.entity';
import { BranchEntity } from '../branch/branch.entity';
import { RoutingService } from '../geo/routing.provider';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { RuleEngine } from './rule.engine';
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
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class ClientRestrictionFilter implements CandidateFilter {
    name: string;
    evaluate(assayer: AssayerEntity, context: PlanningContext): Promise<boolean>;
}
export declare class RuleEngineEligibilityFilter implements CandidateFilter {
    private readonly ruleEngine;
    name: string;
    constructor(ruleEngine: RuleEngine);
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
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class BranchFamiliarityScoreCalculator implements ScoreCalculator {
    private readonly assignmentRepository;
    name: string;
    constructor(assignmentRepository: Repository<AssignmentEntity>);
    calculate(assayer: AssayerEntity, context: PlanningContext): Promise<number>;
}
export declare class SLAComplianceScoreCalculator implements ScoreCalculator {
    name: string;
    calculate(): Promise<number>;
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
    private readonly clientRestrictionFilter;
    private readonly ruleEngineEligibilityFilter;
    private readonly distanceCalculator;
    private readonly travelTimeCalculator;
    private readonly workloadCalculator;
    private readonly performanceCalculator;
    private readonly experienceCalculator;
    private readonly costCalculator;
    private readonly clientPreferenceCalculator;
    private readonly branchFamiliarityCalculator;
    private readonly slaComplianceCalculator;
    private readonly profitabilityCalculator;
    private readonly riskCalculator;
    private readonly assayerRepository;
    private readonly clientRepository;
    private filters;
    private calculators;
    constructor(availabilityFilter: AvailabilityFilter, clientRestrictionFilter: ClientRestrictionFilter, ruleEngineEligibilityFilter: RuleEngineEligibilityFilter, distanceCalculator: DistanceScoreCalculator, travelTimeCalculator: TravelTimeScoreCalculator, workloadCalculator: WorkloadScoreCalculator, performanceCalculator: PerformanceScoreCalculator, experienceCalculator: ExperienceScoreCalculator, costCalculator: CostScoreCalculator, clientPreferenceCalculator: ClientPreferenceScoreCalculator, branchFamiliarityCalculator: BranchFamiliarityScoreCalculator, slaComplianceCalculator: SLAComplianceScoreCalculator, profitabilityCalculator: ProfitabilityScoreCalculator, riskCalculator: RiskScoreCalculator, assayerRepository: Repository<AssayerEntity>, clientRepository: Repository<ClientEntity>);
    recommend(branch: BranchEntity, scheduledDate: Date, weights?: Record<string, number>): Promise<{
        assayer: AssayerEntity;
        score: number;
        breakdown: Record<string, number>;
    }[]>;
}
