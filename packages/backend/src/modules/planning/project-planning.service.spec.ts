import { Test, TestingModule } from '@nestjs/testing';
import { ProjectPlanningService } from './project-planning.service';
import { ProjectQueryService } from '../project/project-query.service';
import { PlanningService } from './planning.service';
import { NotFoundException } from '@nestjs/common';

describe('ProjectPlanningService', () => {
  let service: ProjectPlanningService;

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
        ProjectPlanningService,
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

    service = module.get<ProjectPlanningService>(ProjectPlanningService);
    jest.clearAllMocks();
  });

  it('should throw NotFoundException if project is missing', async () => {
    mockProjectQueryService.findOne.mockResolvedValue(null);

    await expect(service.getProjectPlanningCandidates('p-missing')).rejects.toThrow(NotFoundException);
  });

  it('should compile candidates report for unassigned branches', async () => {
    const project = { id: 'p-1', name: 'Project 1', projectNumber: 'P001' };
    mockProjectQueryService.findOne.mockResolvedValue(project);

    mockProjectQueryService.findProjectBranches.mockResolvedValue([
      {
        id: 'pb-1',
        branchId: 'b-1',
        status: 'IMPORTED',
        branch: { branchCode: 'B001', name: 'Branch 1', city: 'Mumbai', state: 'MH' },
      },
      {
        id: 'pb-2',
        branchId: 'b-2',
        status: 'CLOSED', // Assigned branch should be filtered out
        branch: { branchCode: 'B002', name: 'Branch 2', city: 'Pune', state: 'MH' },
      },
    ]);

    mockPlanningService.getRecommendedCandidates.mockResolvedValue([
      { id: 'a-1', displayName: 'Vijay Shankar', score: 85 },
    ]);

    const report = await service.getProjectPlanningCandidates('p-1');

    expect(report.projectId).toBe('p-1');
    expect(report.totalUnassignedBranches).toBe(1);
    expect(report.branches).toHaveLength(1);
    expect(report.branches[0].projectBranchId).toBe('pb-1');
    expect(report.branches[0].candidates).toHaveLength(1);
  });
});
