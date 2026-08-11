import { Test, TestingModule } from '@nestjs/testing';
import { ScenarioPlanningService } from './scenario-planning.service';
import { ProjectQueryService } from '../project/project-query.service';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';
import { OptimizationEngine } from './optimization.engine';
import { RecommendationEngine } from './recommendation.engine';
import { ClientEntity } from '../client/client.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';

describe('ScenarioPlanningService', () => {
  let service: ScenarioPlanningService;

  const mockProjectQueryService = {
    findOne: jest.fn(),
  };

  const mockConfigResolver = {
    resolveRecommendationConfig: jest.fn().mockReturnValue({
      weights: { distance: 0.5 },
      defaultRadius: 50.0,
    }),
  };

  const mockOptimizationEngine = {
    generateProjectDeploymentPlan: jest.fn(),
  };

  const mockClientRepo = {
    findOne: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScenarioPlanningService,
        {
          provide: ProjectQueryService,
          useValue: mockProjectQueryService,
        },
        {
          provide: ConfigurationResolver,
          useValue: mockConfigResolver,
        },
        {
          provide: RecommendationEngine,
          useValue: {},
        },
        {
          provide: OptimizationEngine,
          useValue: mockOptimizationEngine,
        },
        {
          provide: getRepositoryToken(ClientEntity),
          useValue: mockClientRepo,
        },
      ],
    }).compile();

    service = module.get<ScenarioPlanningService>(ScenarioPlanningService);
    jest.clearAllMocks();
  });

  it('should throw NotFoundException if project is missing', async () => {
    mockProjectQueryService.findOne.mockResolvedValue(null);

    await expect(
      service.simulatePlanningScenario({ projectId: 'p-missing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should override weights and run simulation successfully', async () => {
    const project = { id: 'p-1', clientId: 'c-1', name: 'Project 1' };
    const client = { id: 'c-1', planningPreferences: { weights: { distance: 0.2 } } };

    mockProjectQueryService.findOne.mockResolvedValue(project);
    mockClientRepo.findOne.mockResolvedValue(client);
    mockOptimizationEngine.generateProjectDeploymentPlan.mockResolvedValue({
      projectId: 'p-1',
      totalBranchesMatched: 1,
      assignments: [],
    });

    const result = await service.simulatePlanningScenario({
      projectId: 'p-1',
      weightOverrides: { distance: 0.8 },
    });

    expect(result.projectId).toBe('p-1');
    expect(mockConfigResolver.resolveRecommendationConfig).toHaveBeenCalled();
    // The resolved weights must be threaded into scoring — previously the simulation ignored its
    // only input. The engine is called with the project id AND the resolved weight overrides.
    expect(mockOptimizationEngine.generateProjectDeploymentPlan).toHaveBeenCalledWith('p-1', { distance: 0.5 });
  });
});
