import { Test, TestingModule } from '@nestjs/testing';
import { OptimizationEngine } from './optimization.engine';
import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService } from './planning.service';
import { NotFoundException } from '@nestjs/common';

describe('OptimizationEngine', () => {
  let engine: OptimizationEngine;

  const mockProjectQueryService = {
    findOne: jest.fn(),
    findProjectBranches: jest.fn(),
  };

  const mockPlanningService = {
    getRecommendedCandidates: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OptimizationEngine,
        {
          provide: ProjectQueryService,
          useValue: mockProjectQueryService,
        },
        {
          provide: PlanningService,
          useValue: mockPlanningService,
        },
      ],
    }).compile();

    engine = module.get<OptimizationEngine>(OptimizationEngine);
    jest.clearAllMocks();
  });

  it('should throw NotFoundException if project is missing', async () => {
    mockProjectQueryService.findOne.mockResolvedValue(null);

    await expect(engine.generateProjectDeploymentPlan('p-missing')).rejects.toThrow(NotFoundException);
  });

  it('should solve deployment plan using greedy selection', async () => {
    const project = { id: 'p-1', name: 'Project 1' };
    mockProjectQueryService.findOne.mockResolvedValue(project);

    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      {
        id: 'pb-1',
        branchId: 'b-1',
        status: 'IMPORTED',
        branch: { name: 'Branch Mumbai' },
      },
    ]);

    mockPlanningService.getRecommendedCandidates.mockResolvedValue([
      { id: 'a-1', displayName: 'Vijay Shankar', score: 85 },
      { id: 'a-2', displayName: 'Karthik Raja', score: 70 },
    ]);

    const plan = await engine.generateProjectDeploymentPlan('p-1');

    expect(plan.projectId).toBe('p-1');
    expect(plan.totalBranchesMatched).toBe(1);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].assignedAssayerId).toBe('a-1');
  });
});
