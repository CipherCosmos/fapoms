import { Test, TestingModule } from '@nestjs/testing';
import { CoveragePlanningEngine } from './coverage-planning.engine';
import { ProjectQueryService } from '../project/project-query.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { ClusterManager } from './cluster.manager';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ClientEntity } from '../client/client.entity';
import { getRepositoryToken } from '@nestjs/typeorm';

describe('CoveragePlanningEngine', () => {
  let engine: CoveragePlanningEngine;

  const mockProjectQueryService = {
    findOne: jest.fn().mockResolvedValue({ id: 'p-1', name: 'Project Alpha', clientId: 'c-1' }),
    findProjectBranches: jest.fn().mockResolvedValue([
      { status: 'IMPORTED', branch: { id: 'b-1', name: 'Branch 1', latitude: 19.0, longitude: 72.0 } },
    ]),
  };

  const mockRecommendationEngine = {
    recommend: jest.fn().mockResolvedValue([
      { assayer: { id: 'a-1', displayName: 'Vijay Shankar' }, score: 90, breakdown: {} },
    ]),
  };

  const mockBranchProvider = {
    getBranchesForPlanning: jest.fn().mockResolvedValue([
      { branchId: { value: 'b-1' }, name: 'Branch 1', location: { latitude: 19.0, longitude: 72.0 }, requiredSkills: { values: ['Gold'] } },
    ]),
  };

  const mockAssayerProvider = {
    getAvailableAssayers: jest.fn().mockResolvedValue([
      { assayerId: { value: 'a-1' }, displayName: 'Vijay Shankar', status: 'ACTIVE', location: { latitude: 19.0, longitude: 72.0 }, skills: { values: ['Gold'] }, maxWeeklyWorkload: 15 },
    ]),
  };

  const mockWorkloadProvider = {
    getAssayerCurrentWorkloads: jest.fn().mockResolvedValue({ 'a-1': 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoveragePlanningEngine,
        ClusterManager,
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: RecommendationEngine, useValue: mockRecommendationEngine },
        { provide: ConstraintEvaluator, useValue: {} },
        { provide: 'PlanningBranchProvider', useValue: mockBranchProvider },
        { provide: 'AssayerAvailabilityProvider', useValue: mockAssayerProvider },
        { provide: 'WorkloadProvider', useValue: mockWorkloadProvider },
      ],
    }).compile();

    engine = module.get<CoveragePlanningEngine>(CoveragePlanningEngine);
    jest.clearAllMocks();
  });

  it('should generate a coverage plan including capacity analysis and confidence metrics', async () => {
    const plan = await engine.generateCoveragePlan('p-1');

    expect(plan.projectId).toBe('p-1');
    expect(plan.coveragePercentage).toBe(100);
    expect(plan.confidenceScore).toBe(100);
    expect(plan.workforceCapacity.length).toBe(1);
    expect(plan.clusters.length).toBe(1);
    expect(plan.clusters[0].assignedAssayerName).toBe('Vijay Shankar');
  });
});
