import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectBranchStatus } from '@fapoms/shared';

/**
 * `getProjectCoverage` used to `find()` every active branch of a project and bucket-count
 * statuses in app code — unbounded on a project with many branches. It now asks the database
 * for a `GROUP BY status` count, a single small aggregate query regardless of branch count.
 */
describe('PlanningOrchestratorService', () => {
  let service: PlanningOrchestratorService;

  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };

  const mockProjectBranchRepo = {
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockProjectBranchRepo.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningOrchestratorService,
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
      ],
    }).compile();

    service = module.get<PlanningOrchestratorService>(PlanningOrchestratorService);
  });

  it('issues a single GROUP BY query rather than loading every branch row', async () => {
    qb.getRawMany.mockResolvedValue([
      { status: ProjectBranchStatus.SCHEDULED, count: '3' },
      { status: ProjectBranchStatus.ASSIGNMENT_CONFIRMED, count: '2' },
      { status: ProjectBranchStatus.IMPORTED, count: '5' },
    ]);

    const result = await service.getProjectCoverage('proj-1');

    expect(mockProjectBranchRepo.find).not.toHaveBeenCalled();
    expect(mockProjectBranchRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.groupBy).toHaveBeenCalledWith('pb.status');
    expect(result.total).toBe(10);
    expect(result.scheduled).toBe(3);
    expect(result.confirmed).toBe(2);
    expect(result.remaining).toBe(5);
  });

  it('rolls SCHEDULED, CLOSED and VALIDATION_COMPLETED into "scheduled"', async () => {
    qb.getRawMany.mockResolvedValue([
      { status: ProjectBranchStatus.SCHEDULED, count: '1' },
      { status: ProjectBranchStatus.CLOSED, count: '2' },
      { status: ProjectBranchStatus.VALIDATION_COMPLETED, count: '3' },
    ]);

    const result = await service.getProjectCoverage('proj-1');

    expect(result.scheduled).toBe(6);
    expect(result.confirmed).toBe(0);
    expect(result.total).toBe(6);
  });

  it('returns all zeros when the project has no active branches', async () => {
    qb.getRawMany.mockResolvedValue([]);

    const result = await service.getProjectCoverage('proj-empty');

    expect(result).toEqual({ total: 0, scheduled: 0, confirmed: 0, remaining: 0, coveragePercentage: 0 });
  });
});
