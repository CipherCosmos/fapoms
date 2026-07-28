import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { ClientEntity } from '../client/client.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecommendationEngine } from './recommendation.engine';
import { OptimizationEngine, OptimizationPlan } from './optimization.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';

export interface ScenarioSimulationRequest {
  projectId: string;
  weightOverrides?: Record<string, number>;
  defaultRadiusOverride?: number;
}

@Injectable()
export class ScenarioPlanningService {
  constructor(
    private readonly projectQueryService: ProjectQueryService,
    private readonly configResolver: ConfigurationResolver,
    private readonly recommendationEngine: RecommendationEngine,
    private readonly optimizationEngine: OptimizationEngine,
    @InjectRepository(ClientEntity)
    private readonly clientRepository: Repository<ClientEntity>,
  ) {}

  /**
   * Simulates an optimization run with user-defined parameters without persisting anything to the database.
   */
  async simulatePlanningScenario(dto: ScenarioSimulationRequest): Promise<OptimizationPlan> {
    const project = await this.projectQueryService.findOne(dto.projectId);
    if (!project) {
      throw new NotFoundException(`Project ${dto.projectId} not found.`);
    }

    const client = await this.clientRepository.findOne({
      where: { id: project.clientId, isActive: true },
    });

    // Resolve the merged configuration temporarily for this run
    const resolvedConfig = this.configResolver.resolveRecommendationConfig(client, {
      weights: dto.weightOverrides || {},
      defaultRadius: dto.defaultRadiusOverride ?? 50.0,
    });

    // Execute sandbox greedy solver matching run
    // Since optimization logic resides in OptimizationEngine, and we want to preserve parameters,
    // we run it with temporarily overridden client planningPreferences.
    const originalPreferences = client?.planningPreferences ?? null;
    
    if (client) {
      client.planningPreferences = {
        weights: resolvedConfig.weights,
      };
    }

    try {
      const plan = await this.optimizationEngine.generateProjectDeploymentPlan(dto.projectId);
      return plan;
    } finally {
      // Revert the temporary property override on the shared object instance to prevent pollution
      if (client) {
        client.planningPreferences = originalPreferences;
      }
    }
  }
}
