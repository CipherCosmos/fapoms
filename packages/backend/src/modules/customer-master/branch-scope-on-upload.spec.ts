import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as xlsx from 'xlsx';
import { CustomerMasterService } from './customer-master.service';
import { CustomerMasterVersionEntity } from './customer-master-version.entity';
import { CustomerRecordEntity } from './customer-record.entity';
import { BranchEntity } from '../branch/branch.entity';
import { ProjectEntity } from '../project/project.entity';
import { AuditService } from '../../core/audit/audit.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/**
 * A SOL ID only means something inside one client.
 *
 * The reconciler built its branch lookup from `branchRepository.find({ select: ['id', 'solId'] })`
 * — every branch in the system, keyed on SOL ID alone, no client filter and no `isActive` filter.
 * But a SOL ID is a bank's own branch numbering, and the database says it is unique only per
 * client: `UQ_branches_client_sol_id UNIQUE (client_id, sol_id) WHERE is_active = true`. Every bank
 * has a branch "1".
 *
 * So `Map.set` silently kept whichever client loaded last, and a customer account could be filed
 * against another bank's branch — which then skews `dailyRun`'s per-branch counts and misdirects
 * the region filter in `findRecords`, both of which read `customer_records.branch_id`.
 */
describe('customer master upload — a SOL ID may only match this client\'s branches', () => {
  let service: CustomerMasterService;

  const branchFind = jest.fn();
  const projectFindOne = jest.fn();
  /** Every `customer_records` row the reconciler tried to write, in order. */
  let insertedRecords: any[] = [];

  /** One account row, carrying a SOL ID that more than one bank uses. */
  const sheet = (solId: string): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([
      { 'SOL ID': solId, 'Account Number': 'ACC-1', 'Customer Name': 'A Customer' },
    ]), 'Sheet1');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    insertedRecords = [];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerMasterService,
        { provide: getRepositoryToken(CustomerMasterVersionEntity), useValue: {
          find: jest.fn().mockResolvedValue([]), findOne: jest.fn(),
        } },
        { provide: getRepositoryToken(CustomerRecordEntity), useValue: {
          find: jest.fn().mockResolvedValue([]), findAndCount: jest.fn(), createQueryBuilder: jest.fn(),
        } },
        { provide: getRepositoryToken(BranchEntity), useValue: { find: branchFind } },
        { provide: getRepositoryToken(ProjectEntity), useValue: { findOne: projectFindOne } },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: getDataSourceToken(), useValue: {
          query: jest.fn(),
          transaction: jest.fn(async (fn: any) => fn({
            create: jest.fn((_e: any, v: any) => v),
            save: jest.fn(async (_e: any, v: any) => (Array.isArray(v) ? v : { id: 'v-1', ...v })),
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn(),
            /**
             * A chainable stub that also captures what was inserted.
             *
             * The reconciler both inserts customer records and updates the previous version's
             * status through the query builder, so every link has to return something chainable —
             * and `values()` is where the rows we want to assert on actually appear, since the
             * records never pass through `save()`.
             */
            createQueryBuilder: jest.fn(() => {
              const chain: any = new Proxy(
                {
                  execute: jest.fn().mockResolvedValue({ affected: 0, raw: [] }),
                  values: (v: any) => { insertedRecords.push(...(Array.isArray(v) ? v : [v])); return chain; },
                },
                { get: (t: any, k: string) => (k in t ? t[k] : () => chain) },
              );
              return chain;
            }),
          })),
        } as unknown as DataSource },
        { provide: RegionGuardService, useValue: { stagedMode: jest.fn().mockResolvedValue('off') } },
        { provide: 'StorageEngine', useValue: { upload: jest.fn(), getSignedUrl: jest.fn() } },
      ],
    }).compile();

    service = module.get(CustomerMasterService);
  });

  /**
   * The collision itself, with both banks present.
   *
   * HDFC and ICICI each run a branch numbered `0001` — the everyday case, since a SOL ID is the
   * bank's own numbering. The repository stub below behaves like the real one and honours the
   * `where` clause, so this test fails the moment the scope is dropped: with an unscoped fetch both
   * rows arrive, `Map.set` keeps whichever came last, and the account is written against ICICI's
   * branch id while belonging to an HDFC project.
   *
   * That misfiled `customer_records.branch_id` is not cosmetic. `dailyRun` reads it, so the branch
   * the account really belongs to shows as "not in batch" while the other bank's inflates
   * `unexpectedBranchesInBatch`; and `findRecords` filters on the *joined* branch's region, so the
   * row lands under the wrong desk.
   */
  it("binds an account to its own client's branch when two clients share the SOL ID", async () => {
    const ALL_BRANCHES = [
      { id: 'b-hdfc', solId: '0001', clientId: 'hdfc', isActive: true },
      { id: 'b-icici', solId: '0001', clientId: 'icici', isActive: true },
      // The archived predecessor of the HDFC branch, which shares its SOL ID. Live rows only.
      { id: 'b-hdfc-old', solId: '0001', clientId: 'hdfc', isActive: false },
    ];
    // Behaves like the repository: applies the `where` it is given, rather than returning
    // everything regardless. A stub that ignored the filter could not fail on the bug.
    branchFind.mockImplementation(async ({ where }: any) =>
      ALL_BRANCHES.filter((b) =>
        (where?.clientId === undefined || b.clientId === where.clientId)
        && (where?.isActive === undefined || b.isActive === where.isActive),
      ).map(({ id, solId }) => ({ id, solId })),
    );
    projectFindOne.mockResolvedValue({ id: 'p-hdfc', clientId: 'hdfc' });

    const report = await service.uploadAndReconcile('p-hdfc', 'f.xlsx', '/tmp/f.xlsx', sheet('0001'), 'user-1');

    expect(insertedRecords).toHaveLength(1);
    expect(insertedRecords[0].branchId).toBe('b-hdfc');
    expect(insertedRecords[0].branchId).not.toBe('b-icici');
    // And the archived HDFC branch with the same SOL ID is not the one it chose either.
    expect(insertedRecords[0].branchId).not.toBe('b-hdfc-old');
    expect(report.unmatchedAccounts).toHaveLength(0);
  });

  /** The mirror image: the same file uploaded against the other bank's project. */
  it('binds the same SOL ID to the other client when uploaded against their project', async () => {
    branchFind.mockImplementation(async ({ where }: any) =>
      [
        { id: 'b-hdfc', solId: '0001', clientId: 'hdfc' },
        { id: 'b-icici', solId: '0001', clientId: 'icici' },
      ].filter((b) => b.clientId === where?.clientId).map(({ id, solId }) => ({ id, solId })),
    );
    projectFindOne.mockResolvedValue({ id: 'p-icici', clientId: 'icici' });

    await service.uploadAndReconcile('p-icici', 'f.xlsx', '/tmp/f.xlsx', sheet('0001'), 'user-1');

    expect(insertedRecords[0].branchId).toBe('b-icici');
  });

  it("asks only for this client's live branches, not every branch in the system", async () => {
    projectFindOne.mockResolvedValue({ id: 'p-1', clientId: 'hdfc' });
    branchFind.mockResolvedValue([{ id: 'b-hdfc', solId: '0001' }]);

    await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', sheet('0001'), 'user-1');

    expect(branchFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clientId: 'hdfc', isActive: true }),
      }),
    );
  });

  /**
   * The other half of scoping: when the project's own client has no branch with that SOL ID, the
   * row must be reported unmatched rather than bound to anything. (This one passes against the
   * unscoped code too — the collision tests above are what actually catch the bug.)
   */
  it('reports an account unmatched when its own client has no such branch', async () => {
    projectFindOne.mockResolvedValue({ id: 'p-1', clientId: 'hdfc' });
    // The repository is asked for HDFC only, so ICICI's identically-numbered branch never arrives.
    branchFind.mockResolvedValue([]);

    const report = await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', sheet('0001'), 'user-1');

    expect(report.unmatchedAccounts.length).toBeGreaterThan(0);
    expect(report.unmatchedAccounts[0].solId).toBe('0001');
  });

  it('refuses an upload against a project that does not exist, rather than reconciling against nothing', async () => {
    projectFindOne.mockResolvedValue(null);

    await expect(
      service.uploadAndReconcile('ghost', 'f.xlsx', '/tmp/f.xlsx', sheet('0001'), 'user-1'),
    ).rejects.toThrow(/not found/i);
  });
});
