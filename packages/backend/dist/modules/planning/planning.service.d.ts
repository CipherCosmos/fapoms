import { Repository } from 'typeorm';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { BranchQueryService } from '../branch/branch-query.service';
import { AssayerService } from '../assayer/assayer.service';
import { RecommendationEngine } from './recommendation.engine';
import { RoutingService } from '../geo/routing.provider';
import { ExplanationReason } from './explainability.mapper';
export interface AssayerRecommendation {
    id: string;
    assayerCode: string;
    displayName: string;
    phone: string;
    email: string | null;
    status: string;
    state: string;
    district: string;
    city: string;
    distanceKm: number | null;
    score?: number;
    latitude?: number | null;
    longitude?: number | null;
    baseFee?: number;
    readableReasons?: ExplanationReason[];
    scoreBreakdown?: Record<string, number>;
    pendingOnThisBranch?: boolean;
}
export interface ExcludedCandidate {
    assayerId: string;
    displayName: string;
    reason: string;
    detail?: string;
}
export interface CreateBusinessRuleDto {
    name: string;
    scope: string;
    targetId?: string;
    ruleType: string;
    conditions: Record<string, any>;
    actions?: Record<string, any>;
}
export interface UpdateBusinessRuleDto {
    name?: string;
    scope?: string;
    targetId?: string | null;
    ruleType?: string;
    conditions?: Record<string, any>;
    actions?: Record<string, any> | null;
}
export declare class PlanningService {
    private readonly branchQueryService;
    private readonly ruleRepository;
    private readonly assayerService;
    private readonly recommendationEngine;
    private readonly routingService;
    constructor(branchQueryService: BranchQueryService, ruleRepository: Repository<BusinessRuleEntity>, assayerService: AssayerService, recommendationEngine: RecommendationEngine, routingService: RoutingService);
    getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]>;
    createRule(dto: CreateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity>;
    updateRule(id: string, dto: UpdateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity>;
    deleteRule(id: string, userId: string): Promise<void>;
    getRules(scope?: string): Promise<BusinessRuleEntity[]>;
    getRule(id: string): Promise<BusinessRuleEntity>;
}
