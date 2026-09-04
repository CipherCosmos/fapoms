import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { OperationsProjectMetricsAdapter } from './operations-project-metrics.adapter';
import { ProjectEntity } from '../project/project.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';

/**
 * `getProjectBranchCounts` used to `find({ isActive: true })` every active project-branch row
 * and count/filter it in app code just to produce two integers — unbounded on a table that
 * grows with every branch of every project. It now issues a single aggregate query with two
 * filtered counts, so no branch row ever has to be materialised in Node.
 */
describe('OperationsProjectMetricsAdapter', () => {
  let adapter: OperationsProjectMetricsAdapter;

  const qb: any = {
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(),
  };

  const mockProjectBranchRepo = {
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  };

  const mockProjectRepo = {
    count: jest.fn(),
    find: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockProjectBranchRepo.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperationsProjectMetricsAdapter,
        { provide: getRepositoryToken(ProjectEntity), useValue: mockProjectRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
      ],
    }).compile();

    adapter = module.get<OperationsProjectMetricsAdapter>(OperationsProjectMetricsAdapter);
  });

  it('issues a single aggregate query rather than loading every branch row', async () => {
    qb.getRawOne.mockResolvedValue({ total: '42', deployed: '17' });

    const result = await adapter.getProjectBranchCounts();

    expect(mockProjectBranchRepo.find).not.toHaveBeenCalled();
    expect(mockProjectBranchRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.getRawOne).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 42, deployed: 17 });
  });

  it('filters deployed to statuses other than IMPORTED/PLANNING inside the query', async () => {
    qb.getRawOne.mockResolvedValue({ total: '5', deployed: '3' });

    await adapter.getProjectBranchCounts();

    const deployedFilterCall = qb.addSelect.mock.calls.find((c: any[]) =>
      String(c[0]).includes('FILTER'),
    );
    expect(deployedFilterCall[0]).toContain('IMPORTED');
    expect(deployedFilterCall[0]).toContain('PLANNING');
  });

  it('returns zeros rather than throwing when the aggregate row is empty', async () => {
    qb.getRawOne.mockResolvedValue(undefined);

    const result = await adapter.getProjectBranchCounts();

    expect(result).toEqual({ total: 0, deployed: 0 });
  });
});
