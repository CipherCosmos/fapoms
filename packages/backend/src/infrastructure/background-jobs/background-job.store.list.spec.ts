import { BackgroundJobStore } from './background-job.store';
import { isVisibleTo } from './background-jobs.service';

/**
 * The administrator's job list (SQL, `BackgroundJobStore.list`) and the gate that opens one job
 * (`isVisibleTo`) must agree: a row the list shows but the gate refuses is a dead link, and one the
 * gate opens but the list hides is a job nobody can find.
 */
describe('admin job list agrees with isVisibleTo', () => {
  const clauses = async (filter: any): Promise<string[]> => {
    const where: string[] = [];
    const qb: any = {
      where: (c: string) => { where.push(c); return qb; },
      andWhere: (c: string) => { where.push(c); return qb; },
      orderBy: () => qb, take: () => qb, getMany: async () => [],
    };
    const store = new BackgroundJobStore({ createQueryBuilder: () => qb } as any);
    await store.list({ statuses: ['QUEUED'], limit: 10, ...filter });
    return where;
  };

  it('a regional admin: the list excludes rows with empty regions, exactly as the gate refuses them', async () => {
    const sql = (await clauses({ withinRegions: ['WEST'] })).join(' ');
    expect(sql).toContain('cardinality(j.regions) > 0');
    const reader = { userId: 'admin', roleNames: ['ADMIN'], regions: ['WEST'], organizationId: null };
    expect(isVisibleTo(reader, { requestedBy: 'x', regions: [], organizationId: null })).toBe(false);
    expect(isVisibleTo(reader, { requestedBy: 'x', regions: ['WEST'], organizationId: null })).toBe(true);
  });

  it('an organisation admin: neither the list nor the gate shows a row of no organisation', async () => {
    const sql = (await clauses({ organizationId: 'o1' })).join(' ');
    expect(sql).toContain('j.organization_id = :org');
    const reader = { userId: 'admin', roleNames: ['ADMIN'], regions: null, organizationId: 'o1' };
    expect(isVisibleTo(reader, { requestedBy: 'x', regions: null, organizationId: null })).toBe(false);
    expect(isVisibleTo(reader, { requestedBy: 'x', regions: null, organizationId: 'o1' })).toBe(true);
    // Their own job is always theirs.
    expect(isVisibleTo(reader, { requestedBy: 'admin', regions: null, organizationId: null })).toBe(true);
  });
});
