import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CustomerMasterService } from './customer-master.service';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { Region } from '@fapoms/shared';

/**
 * customer-master had zero region scoping: a region-restricted account (`users.regions` set)
 * saw every region's customer records and every region's branch through `findRecords` and
 * `dailyRun`, the same gap already closed on branch/assignment/project/etc.
 *
 * These are the two list routes that actually have a resolvable region (see
 * `customer-master.service.ts`'s doc comments on why `findByProject` and `approveVersion` do
 * not). Both are staged behind `RegionGuardService.stagedMode()`:
 *  - `off` / an unrestricted account: response identical to before this change.
 *  - `log`: same unfiltered response as `off`, plus a warning.
 *  - `enforce`: the region ceiling actually narrows the result.
 *
 * `null` region on a record/branch is never filtered or refused, in any mode — a data gap, not
 * a security boundary (see `RegionGuardService.assertRegionAllowed`'s doc comment).
 */
describe('customer-master region scoping', () => {
  let service: CustomerMasterService;
  const stagedMode = jest.fn();
  const query = jest.fn();
  const findAndCount = jest.fn();
  const createQueryBuilder = jest.fn();

  const NORTH_RECORD = (overrides: Partial<CustomerRecordEntity> = {}) => ({
    id: 'rec-north',
    branchId: 'branch-north',
    accountNumber: 'ACC-N',
    branch: { id: 'branch-north', region: 'NORTH' },
    ...overrides,
  });
  const SOUTH_RECORD = (overrides: Partial<CustomerRecordEntity> = {}) => ({
    id: 'rec-south',
    branchId: 'branch-south',
    accountNumber: 'ACC-S',
    branch: { id: 'branch-south', region: 'SOUTH' },
    ...overrides,
  });
  const NO_BRANCH_RECORD = (overrides: Partial<CustomerRecordEntity> = {}) => ({
    id: 'rec-unmatched',
    branchId: null,
    accountNumber: 'ACC-U',
    branch: null,
    ...overrides,
  });

  beforeEach(async () => {
    stagedMode.mockReset();
    query.mockReset();
    findAndCount.mockReset();
    createQueryBuilder.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerMasterService,
        { provide: getRepositoryToken(CustomerMasterVersionEntity), useValue: { find: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(CustomerRecordEntity), useValue: { findAndCount, createQueryBuilder, find: jest.fn() } },
        { provide: getRepositoryToken(BranchEntity), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(ProjectEntity), useValue: { findOne: jest.fn() } },
        { provide: AuditService, useValue: { recordEvent: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { query, transaction: jest.fn() } as unknown as DataSource },
        { provide: RegionGuardService, useValue: { stagedMode } },
      ],
    }).compile();
    service = module.get(CustomerMasterService);
  });

  describe('findRecords', () => {
    const allRecords = [NORTH_RECORD(), SOUTH_RECORD(), NO_BRANCH_RECORD()];

    it('never touches stagedMode() or filters for an unrestricted (national) account', async () => {
      findAndCount.mockResolvedValue([allRecords, 3]);

      const result = await service.findRecords('v1', 1, 50, undefined, { regions: null });

      expect(stagedMode).not.toHaveBeenCalled();
      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(findAndCount).toHaveBeenCalledWith({
        where: { customerMasterVersionId: 'v1', isActive: true },
        relations: ['branch'],
        take: 50,
        skip: 0,
      });
      expect(result).toEqual({ records: allRecords, total: 3 });
    });

    it('off mode: response identical to before, no filtering, no stagedMode gate consulted for logging', async () => {
      stagedMode.mockResolvedValue('off');
      findAndCount.mockResolvedValue([allRecords, 3]);

      const result = await service.findRecords('v1', 1, 50, undefined, { regions: [Region.NORTH] });

      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(result).toEqual({ records: allRecords, total: 3 });
    });

    it('log mode: returns the same unfiltered page as off mode (byte-for-byte)', async () => {
      stagedMode.mockResolvedValue('log');
      findAndCount.mockResolvedValue([allRecords, 3]);

      const result = await service.findRecords('v1', 1, 50, undefined, { regions: [Region.NORTH] });

      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(findAndCount).toHaveBeenCalledWith({
        where: { customerMasterVersionId: 'v1', isActive: true },
        relations: ['branch'],
        take: 50,
        skip: 0,
      });
      expect(result).toEqual({ records: allRecords, total: 3 });
    });

    it('log mode logs the would-be exclusion from the page already fetched, without a second query', async () => {
      stagedMode.mockResolvedValue('log');
      findAndCount.mockResolvedValue([allRecords, 3]);
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      await service.findRecords('v1', 1, 50, undefined, { regions: [Region.NORTH] });

      // Exactly one DB round trip — findAndCount — no extra query() call for the log line.
      expect(findAndCount).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would exclude 1/3'));
      warnSpy.mockRestore();
    });

    it('enforce mode narrows the query itself, keeping null-region rows visible', async () => {
      stagedMode.mockResolvedValue('enforce');
      const qb: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[NORTH_RECORD(), NO_BRANCH_RECORD()], 2]),
      };
      createQueryBuilder.mockReturnValue(qb);

      const result = await service.findRecords('v1', 1, 50, undefined, { regions: [Region.NORTH] });

      expect(findAndCount).not.toHaveBeenCalled();
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(branch.region IS NULL OR branch.region IN (:...regions))',
        { regions: [Region.NORTH] },
      );
      expect(result.total).toBe(2);
      expect(result.records.map((r: any) => r.id)).toEqual(['rec-north', 'rec-unmatched']);
    });

    it('enforce mode still applies the caller-supplied branchId filter', async () => {
      stagedMode.mockResolvedValue('enforce');
      const qb: any = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[NORTH_RECORD()], 1]),
      };
      createQueryBuilder.mockReturnValue(qb);

      await service.findRecords('v1', 1, 50, 'branch-north', { regions: [Region.NORTH] });

      expect(qb.andWhere).toHaveBeenCalledWith('cr.branchId = :branchId', { branchId: 'branch-north' });
    });
  });

  describe('dailyRun', () => {
    const scheduledRows = [
      { project_branch_id: 'pb-1', branch_id: 'branch-north', branch_name: 'North Branch', sol_id: 'N001', region: 'NORTH' },
      { project_branch_id: 'pb-2', branch_id: 'branch-south', branch_name: 'South Branch', sol_id: 'S001', region: 'SOUTH' },
      { project_branch_id: 'pb-3', branch_id: 'branch-none', branch_name: 'No Region Branch', sol_id: 'X001', region: null },
    ];

    const mockQueries = () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM project_branches')) return scheduledRows;
        if (sql.includes('FROM customer_records')) return [];
        if (sql.includes('FROM documents')) return [];
        return [];
      });
    };

    it('never consults stagedMode() for an unrestricted account and returns every scheduled branch', async () => {
      mockQueries();

      const result = await service.dailyRun('proj-1', '2026-09-01', { regions: null });

      expect(stagedMode).not.toHaveBeenCalled();
      expect(result.branches).toHaveLength(3);
      expect(result.summary.scheduledBranches).toBe(3);
    });

    it('off mode returns every scheduled branch unfiltered', async () => {
      mockQueries();
      stagedMode.mockResolvedValue('off');

      const result = await service.dailyRun('proj-1', '2026-09-01', { regions: [Region.NORTH] });

      expect(result.branches).toHaveLength(3);
    });

    it('log mode returns the identical unfiltered branch list and only warns', async () => {
      mockQueries();
      stagedMode.mockResolvedValue('log');
      const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      const result = await service.dailyRun('proj-1', '2026-09-01', { regions: [Region.NORTH] });

      expect(result.branches).toHaveLength(3);
      expect(result.branches.map((b: any) => b.branchId)).toEqual(['branch-north', 'branch-south', 'branch-none']);
      // SOUTH is the only real out-of-scope branch; the null-region branch does not count.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('would exclude 1/3'));
      warnSpy.mockRestore();
    });

    it('enforce mode narrows the branch list but keeps unresolvable-region branches visible', async () => {
      mockQueries();
      stagedMode.mockResolvedValue('enforce');

      const result = await service.dailyRun('proj-1', '2026-09-01', { regions: [Region.NORTH] });

      expect(result.branches.map((b: any) => b.branchId)).toEqual(['branch-north', 'branch-none']);
      expect(result.summary.scheduledBranches).toBe(2);
    });

    it('enforce mode leaves the client-mismatch count computed off the full unfiltered scheduled set', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM project_branches')) return scheduledRows;
        if (sql.includes('FROM customer_records')) {
          // The client's batch includes a SOUTH branch not visible to this NORTH-only account.
          return [{ branch_id: 'branch-south', record_count: '5', packet_total: '5' }];
        }
        if (sql.includes('FROM documents')) return [];
        return [];
      });
      stagedMode.mockResolvedValue('enforce');

      const result = await service.dailyRun('proj-1', '2026-09-01', { regions: [Region.NORTH] });

      // branch-south IS scheduled, so it is not "unexpected" — this just proves the mismatch
      // metric did not silently change shape when the branch list was narrowed.
      expect(result.summary.unexpectedBranchesInBatch).toBe(0);
    });
  });
});
