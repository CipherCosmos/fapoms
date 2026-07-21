import { Repository } from 'typeorm';
import { BranchEntity } from '../branch/branch.entity';
import { BusinessRuleEntity } from './business-rule.entity';
import { RecommendationEngine } from './recommendation.engine';
import { RoutingService } from '../geo/routing.provider';
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
    private readonly branchRepository;
    private readonly ruleRepository;
    private readonly recommendationEngine;
    private readonly routingService;
    constructor(branchRepository: Repository<BranchEntity>, ruleRepository: Repository<BusinessRuleEntity>, recommendationEngine: RecommendationEngine, routingService: RoutingService);
    getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]>;
    createRule(dto: CreateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity>;
    updateRule(id: string, dto: UpdateBusinessRuleDto, userId: string): Promise<BusinessRuleEntity>;
    deleteRule(id: string, userId: string): Promise<void>;
    getRules(scope?: string): Promise<BusinessRuleEntity[]>;
    getRule(id: string): Promise<BusinessRuleEntity>;
}
