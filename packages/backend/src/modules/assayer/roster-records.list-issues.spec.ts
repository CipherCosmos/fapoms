import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
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
 *
 * Also pinned here: the queue is region-scoped like the roster it is drawn from
 * (`assayer.region`, via the same `issue.assayer` join the row list already carries for its
 * display columns), joined through a SECOND, independent query builder for the open count — the
 * count has no `.take()` ceiling of its own and must stay exact regardless of what the row list
 * is showing.
 */
describe('RosterRecordsService.listIssues', () => {
  let service: RosterRecordsService;
  let issues: any;
  /** Every query builder `createQueryBuilder` handed out, in call order: rows first, count second. */
  let createdQbs: any[];

  function makeQb(rows: any[] = [{ id: 'i-1' }, { id: 'i-2' }], count = 283) {
    return {
      leftJoin: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
      getCount: jest.fn().mockResolvedValue(count),
    };
  }

  beforeEach(async () => {
    createdQbs = [];
    issues = {
      createQueryBuilder: jest.fn(() => {
        const qb = makeQb();
        createdQbs.push(qb);
        return qb;
      }),
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
        // `setEmpanelment` locks its row before reading it; nothing here reaches that path.
        { provide: getDataSourceToken(), useValue: {} },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
  });

  it('serves the newest findings first — a fresh defect must not queue behind years of old cells', async () => {
    await service.listIssues();
    const [rowsQb] = createdQbs;
    expect(rowsQb.orderBy).toHaveBeenCalledWith('issue.createdAt', 'DESC');
  });

  it('defaults to the full 500 ceiling instead of silently clipping at 200', async () => {
    await service.listIssues();
    const [rowsQb] = createdQbs;
    expect(rowsQb.take).toHaveBeenCalledWith(500);
  });

  it('still honours a smaller caller limit, and clamps anything above the ceiling', async () => {
    await service.listIssues({ limit: 50 });
    expect(createdQbs[0].take).toHaveBeenCalledWith(50);

    createdQbs.length = 0;
    await service.listIssues({ limit: 9_000 });
    expect(createdQbs[0].take).toHaveBeenCalledWith(500);
  });

  it('reports the exact open count beside a capped row list, so the panel can say "showing X of Y"', async () => {
    const { rows, openCount } = await service.listIssues();
    expect(rows).toHaveLength(2);
    expect(openCount).toBe(283); // full count — deliberately NOT rows.length

    // A genuinely separate query, not `rows.length` in disguise: its own query builder, with no
    // `.take()` ceiling at all.
    const [rowsQb, countQb] = createdQbs;
    expect(countQb).toBeDefined();
    expect(countQb.getCount).toHaveBeenCalled();
    expect(countQb.take).not.toHaveBeenCalled();
    expect(rowsQb.getMany).toHaveBeenCalled();
  });

  it('lists open findings only unless resolved ones are asked for — and the open count beside it always means open', async () => {
    await service.listIssues();
    expect(createdQbs[0].where).toHaveBeenCalledWith('issue.resolvedAt IS NULL');
    expect(createdQbs[1].where).toHaveBeenCalledWith('issue.resolvedAt IS NULL');

    createdQbs.length = 0;
    await service.listIssues({ includeResolved: true });
    // The row list stops filtering to unresolved...
    expect(createdQbs[0].where).not.toHaveBeenCalled();
    // ...but the open count beside it still has to say how many are open, regardless of what the
    // list itself is showing.
    expect(createdQbs[1].where).toHaveBeenCalledWith('issue.resolvedAt IS NULL');
  });

  /**
   * The roster this queue is drawn from is region-scoped; until now the queue itself was not, so
   * a region-scoped desk saw import issues for every territory rather than their own.
   */
  describe('region scope', () => {
    it('scopes both the row list and the open count by the ISSUE\'S OWN assayer region', async () => {
      await service.listIssues({ scope: { regions: ['SOUTH'] } as any });

      const [rowsQb, countQb] = createdQbs;
      const expectedClause = '(assayer.region IN (:...regions) OR issue.assayerId IS NULL)';
      expect(rowsQb.andWhere).toHaveBeenCalledWith(expectedClause, { regions: ['SOUTH'] });
      expect(countQb.andWhere).toHaveBeenCalledWith(expectedClause, { regions: ['SOUTH'] });
    });

    /**
     * An issue with no assayer attached — the commonest cause is a source code the importer
     * could not even match — has no region to test either way, so `OR issue.assayerId IS NULL`
     * keeps it visible in every region's queue rather than dropping it out of all of them the
     * moment any scope narrows. Asserted above via the exact SQL fragment; this test pins that
     * the OR is present precisely because a scope was given, not unconditionally.
     */
    it('does not scope at all when no region is given — national desks keep seeing everything', async () => {
      await service.listIssues();
      const [rowsQb, countQb] = createdQbs;
      expect(rowsQb.andWhere).not.toHaveBeenCalled();
      expect(countQb.andWhere).not.toHaveBeenCalled();
    });

    it('also does not scope when the scope carries an empty regions list', async () => {
      await service.listIssues({ scope: { regions: [] } as any });
      const [rowsQb, countQb] = createdQbs;
      expect(rowsQb.andWhere).not.toHaveBeenCalled();
      expect(countQb.andWhere).not.toHaveBeenCalled();
    });
  });
});
