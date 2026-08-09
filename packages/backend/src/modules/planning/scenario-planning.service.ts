import { Injectable, NotFoundException } from '@nestjs/common';
import { ProjectQueryService } from '../project/project-query.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { ClientEntity } from '../client/client.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

    // Resolve the merged configuration for this run: the operator's weight overrides layered over
    // the client's own configured weights.
    const resolvedConfig = this.configResolver.resolveRecommendationConfig(client, {
      weights: dto.weightOverrides || {},
      defaultRadius: dto.defaultRadiusOverride ?? 50.0,
    });

    // Thread the resolved weights straight into scoring. This used to mutate
    // `client.planningPreferences` on a fetched instance and hope the engine read it — but the
    // engine re-loads its own client and, until now, called `recommend()` with no weights, so the
    // sandbox silently ignored its only input and returned identical output for any weights.
    return this.optimizationEngine.generateProjectDeploymentPlan(dto.projectId, resolvedConfig.weights);
  }
}
