import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BranchQueryService } from './branch-query.service';
import { BranchEntity } from './branch.entity';

/**
 * The branch list filters where the rows are.
 *
 * This screen asked for a thousand branches and then searched, filtered and counted them in the
 * browser. Two things were wrong with that, and only one of them was visible. The page paid to
 * fetch and render up to a thousand table rows on every visit — and a client with more branches
 * than the cap had the remainder silently missing from its own search box, which is the kind of
 * wrong answer nobody reports because it looks like a result.
 *
 * The figures above the table have to come from the same filter as the rows beneath it, or the
 * header describes one set and the table another.
 */
describe('branch list filters', () => {
  let service: BranchQueryService;
  const qb: any = {};
  const createQueryBuilder = jest.fn(() => qb);

  beforeEach(async () => {
    for (const m of ['leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'take', 'skip', 'select', 'addSelect']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getManyAndCount = jest.fn(async () => [[], 0]);
    qb.getRawOne = jest.fn(async () => ({ total: '4000', regions: '5', highRisk: '120', standard: '900' }));
    createQueryBuilder.mockClear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BranchQueryService,
        { provide: getRepositoryToken(BranchEntity), useValue: { createQueryBuilder } },
      ],
    }).compile();
    service = module.get(BranchQueryService);
  });

  /** Every predicate the builder was given, as one string. */
  const wheres = () =>
    [...qb.where.mock.calls, ...qb.andWhere.mock.calls].map((c) => String(c[0])).join(' | ');

  it('searches in SQL, across the same fields the page box matched on', async () => {
    await service.findAll(1, 50, {}, { search: 'Arapalayam' });

    const sql = wheres();
    for (const field of ['branch.name', 'branch.branch_code', 'branch.sol_id', 'branch.city']) {
      expect(sql).toContain(field);
    }
    const params = [...qb.andWhere.mock.calls].map((c) => c[1]).filter(Boolean);
    expect(params).toContainEqual({ q: '%Arapalayam%' });
  });

  it('ignores a blank search rather than matching everything against an empty string', async () => {
    await service.findAll(1, 50, {}, { search: '   ' });
    expect(wheres()).not.toContain('ILIKE');
  });

  it('treats ALL as no filter, which is what the picker means by it', async () => {
    await service.findAll(1, 50, {}, { risk: 'ALL', type: 'ALL' });
    expect(wheres()).not.toContain('risk_category');
    expect(wheres()).not.toContain('branch_type');
  });

  it('breaks the name tie so a row cannot swap pages between requests', async () => {
    await service.findAll(2, 50, {});
    expect(qb.orderBy).toHaveBeenCalledWith('branch.name', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('branch.id', 'ASC');
    expect(qb.skip).toHaveBeenCalledWith(50);
    expect(qb.take).toHaveBeenCalledWith(50);
  });

  it('counts the whole filtered set for the header, not the page', async () => {
    const summary = await service.summary({}, { search: 'Arapalayam' });

    // No window on the summary — it answers "how many are there", not "how many did we send".
    expect(qb.take).not.toHaveBeenCalled();
    expect(qb.skip).not.toHaveBeenCalled();
    expect(summary).toEqual({ total: 4000, regions: 5, highRisk: 120, standard: 900 });
  });

  it('asks the header and the rows the same question', async () => {
    await service.findAll(1, 50, { clientId: 'c-1' }, { search: 'Arapalayam', risk: 'HIGH' });
    const listSql = wheres();

    qb.where.mockClear(); qb.andWhere.mockClear();
    await service.summary({ clientId: 'c-1' }, { search: 'Arapalayam', risk: 'HIGH' });

    // Same predicates, so the four figures cannot describe a different set from the table.
    expect(wheres()).toBe(listSql);
  });
});
