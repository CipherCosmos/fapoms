import { Test, TestingModule } from '@nestjs/testing';
import { OptimizationEngine } from './optimization.engine';
import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService } from './planning.service';
import { NotFoundException } from '@nestjs/common';

describe('OptimizationEngine', () => {
  let engine: OptimizationEngine;

  // Seeded from real committed load: the optimizer must not treat a busy assayer as idle.
  const mockWorkloadProvider = {
    getAssayerCurrentWorkloads: jest.fn().mockResolvedValue({}),
  };

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
        { provide: 'WorkloadProvider', useValue: mockWorkloadProvider },
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

  /**
   * The optimizer used to start every run believing all assayers were idle, and to cap them all
   * at a hardcoded 15 regardless of their own contracted limit. It would therefore stack a full
   * notional week on top of whatever an assayer already owed.
   */
  it("starts from the assayer's real committed load rather than assuming they are free", async () => {
    mockWorkloadProvider.getAssayerCurrentWorkloads.mockResolvedValue({ 'as-1': 3 });
    mockPlanningService.getRecommendedCandidates.mockResolvedValue([
      { id: 'as-1', displayName: 'Vijay Shankar', score: 90, maxWeeklyWorkload: 4 },
    ]);
    mockProjectQueryService.findOne.mockResolvedValue({ id: 'p-1', name: 'Project 1' });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1', status: 'PLANNING', branch: { name: 'Branch 1' } },
      { id: 'pb-2', branchId: 'b-2', status: 'PLANNING', branch: { name: 'Branch 2' } },
    ]);

    const plan = await engine.generateProjectDeploymentPlan('p-1');

    // Cap 4, already owes 3 — room for exactly one more, then they are full.
    expect(plan.assignments).toHaveLength(1);
    expect(plan.unmatchedBranches).toHaveLength(1);
  });

  it("respects each assayer's own cap instead of a single hardcoded limit", async () => {
    mockWorkloadProvider.getAssayerCurrentWorkloads.mockResolvedValue({});
    mockPlanningService.getRecommendedCandidates.mockResolvedValue([
      { id: 'as-1', displayName: 'Vijay Shankar', score: 90, maxWeeklyWorkload: 1 },
    ]);
    mockProjectQueryService.findOne.mockResolvedValue({ id: 'p-1', name: 'Project 1' });
    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      { id: 'pb-1', branchId: 'b-1', status: 'PLANNING', branch: { name: 'Branch 1' } },
      { id: 'pb-2', branchId: 'b-2', status: 'PLANNING', branch: { name: 'Branch 2' } },
    ]);

    const plan = await engine.generateProjectDeploymentPlan('p-1');

    // Under the old hardcoded 15 this assayer would have taken both branches.
    expect(plan.assignments).toHaveLength(1);
    expect(plan.unmatchedBranches).toHaveLength(1);
  });

});
