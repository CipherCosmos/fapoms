import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PlanningOrchestratorService } from './planning-orchestrator.service';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { ProjectBranchStatus } from '@fapoms/shared';

/**
 * `getProjectCoverage` used to `find()` every active branch of a project and bucket-count
 * statuses in app code — unbounded on a project with many branches. It now asks the database
 * for a `GROUP BY status` count, a single small aggregate query regardless of branch count.
 *
 * The bucketing it then applied was its own copy of the coverage definition, and it had drifted
 * from the client-facing workbook's copy. It now calls `coverageFromCounts` from `@fapoms/shared`;
 * the cross-surface agreement is pinned in `reports/coverage-agreement.spec.ts`, and what is
 * tested here is that this service still asks the database the cheap question.
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
    expect(result.completed).toBe(0);
  });

  it('reports finished work as completed, not as scheduled', async () => {
    // The regression: CLOSED and VALIDATION_COMPLETED were summed into the bucket *labelled*
    // `scheduled`, so a planner was shown delivered audits as work still to be staffed — and
    // AUDIT_COMPLETED, which had no bucket at all, was reported as `remaining`.
    qb.getRawMany.mockResolvedValue([
      { status: ProjectBranchStatus.SCHEDULED, count: '1' },
      { status: ProjectBranchStatus.CLOSED, count: '2' },
      { status: ProjectBranchStatus.VALIDATION_COMPLETED, count: '3' },
      { status: ProjectBranchStatus.AUDIT_COMPLETED, count: '4' },
    ]);

    const result = await service.getProjectCoverage('proj-1');

    expect(result.scheduled).toBe(1);
    expect(result.completed).toBe(9);
    expect(result.remaining).toBe(0);
    expect(result.total).toBe(10);
    expect(result.coveragePercentage).toBe(100);
  });

  it('returns all zeros when the project has no active branches', async () => {
    qb.getRawMany.mockResolvedValue([]);

    const result = await service.getProjectCoverage('proj-empty');

    expect(result).toEqual({
      total: 0, completed: 0, scheduled: 0, confirmed: 0, remaining: 0, covered: 0, coveragePercentage: 0,
    });
  });
});
