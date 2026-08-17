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

  /**
   * The loop below runs the whole recommendation engine once per unassigned branch and is where
   * all of the measured 12.2 s (200-branch project, scale database) goes. When this runs as a
   * queued job, that count is what the poll endpoint turns into a progress bar.
   */
  describe('progress reporting', () => {
    const unassigned = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `pb-${i}`,
        branchId: `b-${i}`,
        status: 'IMPORTED',
        branch: { branchCode: `B${i}`, name: `Branch ${i}`, city: 'Mumbai', state: 'MH' },
      }));

    beforeEach(() => {
      mockProjectQueryService.findOne.mockResolvedValue({ id: 'p-1', name: 'Project 1', projectNumber: 'P001' });
      mockPlanningService.getRecommendedCandidates.mockResolvedValue([]);
    });

    it('reports once per unassigned branch, against the unassigned total', async () => {
      // The total must be the *unassigned* count, not every project branch: reporting against
      // the whole book would leave the bar stuck at a fraction on a mostly-scheduled project.
      mockProjectQueryService.findProjectBranches.mockResolvedValue([
        ...unassigned(3),
        { id: 'pb-x', branchId: 'b-x', status: 'CLOSED', branch: { branchCode: 'BX', name: 'Closed', city: 'Pune', state: 'MH' } },
      ]);
      const onProgress = jest.fn();

      await service.getProjectPlanningCandidates('p-1', undefined, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(3);
      expect(onProgress).toHaveBeenLastCalledWith(3, 3, 'Ranking candidates');
    });

    it('still counts a branch whose candidate lookup threw', async () => {
      // The loop swallows a per-branch failure and carries on with an empty list. Skipping the
      // progress report there would silently strand the bar below 100%.
      mockProjectQueryService.findProjectBranches.mockResolvedValue(unassigned(2));
      mockPlanningService.getRecommendedCandidates
        .mockRejectedValueOnce(new Error('branch b-0 has no coordinates'))
        .mockResolvedValueOnce([]);
      const onProgress = jest.fn();

      await service.getProjectPlanningCandidates('p-1', undefined, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenLastCalledWith(2, 2, 'Ranking candidates');
    });

    it('is optional, so the synchronous route is unchanged', async () => {
      mockProjectQueryService.findProjectBranches.mockResolvedValue(unassigned(1));
      await expect(service.getProjectPlanningCandidates('p-1')).resolves.toBeDefined();
    });
  });
});
