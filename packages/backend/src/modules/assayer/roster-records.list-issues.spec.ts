import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RosterRecordsService } from './roster-records.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * The review-queue read, pinned against the failure it used to have: a default limit of 200
 * ordered oldest-first, with `openCount` counting everything. At 283 open findings the panel
 * headlined 283 while the newest 83 — including every row the data-integrity scanner writes,
 * which all sort last under ASC — were silently absent from the body. The contract now: the
 * default IS the 500 ceiling, the newest findings come first so fresh defects are seen before
 * years-old cells, and the count stays exact so the panel can say "showing X of Y".
 */
describe('RosterRecordsService.listIssues', () => {
  let service: RosterRecordsService;
  let qb: any;
  let issues: any;

  beforeEach(async () => {
    qb = {
      leftJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ id: 'i-1' }, { id: 'i-2' }]),
    };
    issues = {
      createQueryBuilder: jest.fn(() => qb),
      count: jest.fn().mockResolvedValue(283),
    };

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: issues },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
  });

  it('serves the newest findings first — a fresh defect must not queue behind years of old cells', async () => {
    await service.listIssues();
    expect(qb.orderBy).toHaveBeenCalledWith('issue.createdAt', 'DESC');
  });

  it('defaults to the full 500 ceiling instead of silently clipping at 200', async () => {
    await service.listIssues();
    expect(qb.take).toHaveBeenCalledWith(500);
  });

  it('still honours a smaller caller limit, and clamps anything above the ceiling', async () => {
    await service.listIssues({ limit: 50 });
    expect(qb.take).toHaveBeenCalledWith(50);

    await service.listIssues({ limit: 9_000 });
    expect(qb.take).toHaveBeenLastCalledWith(500);
  });

  it('reports the exact open count beside a capped row list, so the panel can say "showing X of Y"', async () => {
    const { rows, openCount } = await service.listIssues();
    expect(rows).toHaveLength(2);
    expect(openCount).toBe(283); // full count — deliberately NOT rows.length
  });

  it('lists open findings only unless resolved ones are asked for', async () => {
    await service.listIssues();
    expect(qb.where).toHaveBeenCalledWith('issue.resolvedAt IS NULL');

    qb.where.mockClear();
    await service.listIssues({ includeResolved: true });
    expect(qb.where).not.toHaveBeenCalled();
  });
});
