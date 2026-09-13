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
 * The read side of the Excel-consolidation fix: `uploadAndReconcile` used to find its columns
 * with a hand-rolled `row['Account Number'] || row.ACCOUNT_NO || row.AccountNo` chain per field,
 * an exact-header match with none of `parseSheet`/`rowReader`'s tolerance for spelling, spacing,
 * a title row above the real headers, or more than one sheet. This file exercises exactly the
 * behavior that changed — not the SOL ID/client-scoping behavior `branch-scope-on-upload.spec.ts`
 * already covers, which this refactor left untouched.
 */
describe('customer master upload — column-name tolerance', () => {
  let service: CustomerMasterService;
  const branchFind = jest.fn();
  const projectFindOne = jest.fn();
  let insertedRecords: any[];

  function bookFromAoa(rowsAoa: unknown[][]): Buffer {
    const ws = xlsx.utils.aoa_to_sheet(rowsAoa);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    insertedRecords = [];
    projectFindOne.mockResolvedValue({ id: 'p-1', clientId: 'c-1' });
    branchFind.mockResolvedValue([{ id: 'b-1', solId: '0001' }]);

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

  it('matches the SCREAMING_SNAKE spelling of every column, not just the human-readable one', async () => {
    const file = bookFromAoa([
      ['ACCOUNT_NO', 'SOL_ID', 'CUSTOMER_NAME', 'PACKET_COUNT'],
      ['ACC-1', '0001', 'Asha Rao', '7'],
    ]);
    const report = await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', file, 'u-1');

    expect(insertedRecords).toHaveLength(1);
    expect(insertedRecords[0]).toMatchObject({
      accountNumber: 'ACC-1', branchId: 'b-1', customerName: 'Asha Rao', packetCount: 7,
    });
    expect(report.unmatchedAccounts).toHaveLength(0);
  });

  it('recognises BRANCH as a SOL ID column — the exact drift between the preview and the real importer this fix closes', async () => {
    // Before this fix, document.controller.ts's preview counted a `BRANCH` header as a match for
    // SOL ID, but this importer's own hand-rolled chain did not — so a file using this heading
    // could preview as "0 missing branches" and then import every row unmatched.
    const file = bookFromAoa([
      ['Account Number', 'BRANCH', 'Customer Name'],
      ['ACC-1', '0001', 'Asha Rao'],
    ]);
    const report = await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', file, 'u-1');

    expect(insertedRecords[0].branchId).toBe('b-1');
    expect(report.unmatchedAccounts).toHaveLength(0);
  });

  it('finds the header row even when a title sits above it', async () => {
    const file = bookFromAoa([
      ['CUSTOMER MASTER — SEPTEMBER 2026'],
      [],
      ['Account Number', 'SOL ID', 'Customer Name'],
      ['ACC-1', '0001', 'Asha Rao'],
    ]);
    const report = await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', file, 'u-1');

    expect(insertedRecords).toHaveLength(1);
    expect(insertedRecords[0].accountNumber).toBe('ACC-1');
    expect(report.unmatchedAccounts).toHaveLength(0);
  });

  it('defaults a blank customer name to "Unknown Customer", not an empty string', async () => {
    const file = bookFromAoa([
      ['Account Number', 'SOL ID', 'Customer Name'],
      ['ACC-1', '0001', ''],
    ]);
    await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', file, 'u-1');

    expect(insertedRecords[0].customerName).toBe('Unknown Customer');
  });

  it('defaults a blank or unparsable packet count to 1, never 0 or NaN', async () => {
    const file = bookFromAoa([
      ['Account Number', 'SOL ID', 'Packets'],
      ['ACC-1', '0001', ''],
      ['ACC-2', '0001', 'not a number'],
    ]);
    await service.uploadAndReconcile('p-1', 'f.xlsx', '/tmp/f.xlsx', file, 'u-1');

    expect(insertedRecords[0].packetCount).toBe(1);
    expect(insertedRecords[1].packetCount).toBe(1);
  });
});
