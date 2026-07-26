import { ProjectQueryService } from '../project/project-query.service';
import { ClientEntity } from '../client/client.entity';
import { Repository } from 'typeorm';
import { RecommendationEngine } from './recommendation.engine';
import { OptimizationEngine, OptimizationPlan } from './optimization.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';
export interface ScenarioSimulationRequest {
    projectId: string;
    weightOverrides?: Record<string, number>;
    defaultRadiusOverride?: number;
}
export declare class ScenarioPlanningService {
    private readonly projectQueryService;
    private readonly configResolver;
    private readonly recommendationEngine;
    private readonly optimizationEngine;
    private readonly clientRepository;
    constructor(projectQueryService: ProjectQueryService, configResolver: ConfigurationResolver, recommendationEngine: RecommendationEngine, optimizationEngine: OptimizationEngine, clientRepository: Repository<ClientEntity>);
    simulatePlanningScenario(dto: ScenarioSimulationRequest): Promise<OptimizationPlan>;
}
