import { RosterQueryService } from './roster-query.service';

/**
 * A `SelectQueryBuilder` stub that records every `andWhere` call and returns itself, so a test
 * can assert which clauses a given filter combination produced without a real database. This is
 * the failure this file guards against: before this service existed, the roster route had no
 * server-side filtering at all — `?state=Kerala` on `GET /assayers` was silently ignored and the
 * whole (region-scoped) table came back, which is exactly the bug a filter catalogue mirrored
 * only on the frontend produces.
 */
function makeQbStub(result: { rows?: any[]; count?: number; raw?: any[] } = {}) {
  const clauses: string[] = [];
  const qb: any = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn((clause: string) => {
      clauses.push(clause);
      return qb;
    }),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([result.rows ?? [], result.count ?? 0]),
    getMany: jest.fn().mockResolvedValue(result.rows ?? []),
    getCount: jest.fn().mockResolvedValue(result.count ?? 0),
    getRawMany: jest.fn().mockResolvedValue(result.raw ?? []),
    __clauses: clauses,
  };
  return qb;
}

function makeService(qb: ReturnType<typeof makeQbStub>) {
  const repo: any = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  return new RosterQueryService(repo);
}

describe('RosterQueryService', () => {
  it('applies no filter clauses when the caller sends none — a bare page is still region-scoped only', async () => {
    const qb = makeQbStub({ rows: [{ id: '1' }], count: 1 });
    const svc = makeService(qb);

    await svc.findFiltered({}, 1, 20, { regions: ['SOUTH'] } as any);

    expect(qb.andWhere).toHaveBeenCalledWith('a.region IN (:...scopeRegions)', { scopeRegions: ['SOUTH'] });
    expect(qb.__clauses.some((c: string) => c.includes('lifecycleStatus'))).toBe(false);
  });

  it('turns a state filter into a real WHERE clause, not a client-side no-op', async () => {
    const qb = makeQbStub({ rows: [], count: 0 });
    const svc = makeService(qb);

    await svc.findFiltered({ state: ['Kerala', 'Goa'] }, 1, 20);

    expect(qb.andWhere).toHaveBeenCalledWith('a.state IN (:...state)', { state: ['Kerala', 'Goa'] });
  });

  it('uses ILIKE over the trigram-indexed columns for search text', async () => {
    const qb = makeQbStub();
    const svc = makeService(qb);

    await svc.findFiltered({ q: 'ravi' }, 1, 20);

    const call = qb.andWhere.mock.calls.find(([clause]: [string]) => clause.includes('ILIKE'));
    expect(call).toBeTruthy();
    expect(call[1]).toEqual({ q: '%ravi%' });
  });

  it('keyset page returns a cursor only when a full page came back', async () => {
    const rows = [{ id: 'a', createdAt: new Date('2026-01-01T00:00:00.000Z') }];
    const qb = makeQbStub({ rows });
    const svc = makeService(qb);

    const fullPage = await svc.findKeyset({}, undefined, 1, undefined);
    expect(fullPage.nextCursor).toBe('2026-01-01T00:00:00.000Z_a');

    const qbShort = makeQbStub({ rows });
    const svcShort = makeService(qbShort);
    const shortPage = await svcShort.findKeyset({}, undefined, 5, undefined);
    expect(shortPage.nextCursor).toBeNull();
  });

  it('search caps the limit at 50 even when a caller asks for more', async () => {
    const qb = makeQbStub({ raw: [] });
    const svc = makeService(qb);

    await svc.search('a', 500);

    expect(qb.take).toHaveBeenCalledWith(50);
  });

  it('search projects only the slim picker fields off the raw row', async () => {
    const qb = makeQbStub({
      raw: [{ a_id: '1', a_assayerCode: 'AS1', a_displayName: 'Ravi', a_state: 'Kerala', a_lifecycleStatus: 'ACTIVE', a_region: 'SOUTH' }],
    });
    const svc = makeService(qb);

    const rows = await svc.search('ravi', 10);

    expect(rows).toEqual([{ id: '1', assayerCode: 'AS1', displayName: 'Ravi', state: 'Kerala', lifecycleStatus: 'ACTIVE', region: 'SOUTH' }]);
  });

  it('streamChunks stops once a short page comes back, never holding the whole roster at once', async () => {
    const firstPage = [{ id: '1', createdAt: new Date('2026-01-02T00:00:00.000Z') }, { id: '2', createdAt: new Date('2026-01-01T00:00:00.000Z') }];
    const secondPage = [{ id: '3', createdAt: new Date('2025-12-31T00:00:00.000Z') }];

    let call = 0;
    const repo: any = {
      createQueryBuilder: jest.fn(() => {
        call += 1;
        return makeQbStub({ rows: call === 1 ? firstPage : secondPage });
      }),
    };
    const svc = new RosterQueryService(repo);

    const chunks: any[][] = [];
    for await (const chunk of svc.streamChunks({}, 2)) chunks.push(chunk);

    expect(chunks).toEqual([firstPage, secondPage]);
  });
});
