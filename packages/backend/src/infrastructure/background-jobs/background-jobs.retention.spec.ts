import { purgeExpiredBackgroundJobs } from './background-jobs.retention';

/**
 * Finished background jobs leave after their window WITH their files, and nothing in progress ever
 * does. The uploaded sheet is often a client's whole branch list; a row deleted without its file
 * would leave that list in the bucket with no screen and no rule attached to it.
 */
describe('purging expired background jobs', () => {
  type Row = {
    id: string;
    input_object_key: string | null;
    result_object_key: string | null;
    input_objects?: Array<{ key: string }> | null;
  };

  const setup = (batches: Row[][], stillUsed: string[] = []) => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const order: string[] = [];
    const queue = [...batches];
    const dataSource = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        statements.push({ sql, params });
        if (sql.includes('SELECT id, input_object_key')) return queue.shift() ?? [];
        if (sql.includes('SELECT 1 AS one')) return stillUsed.includes(params[0] as string) ? [{ one: 1 }] : [];
        if (sql.startsWith('DELETE')) { order.push('delete-rows'); return [[], 0]; }
        return [];
      }),
    };
    const storage = { deleteFile: jest.fn(async (key: string) => { order.push(`delete-file:${key}`); }) };
    return { dataSource, storage, statements, order };
  };

  const cutoff = new Date('2026-08-25T00:00:00Z');

  it('selects only finished rows past the cutoff, never QUEUED or RUNNING ones, oldest first', async () => {
    const { dataSource, storage, statements } = setup([[]]);
    await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 100, 10);
    const select = statements[0].sql;
    expect(select).toMatch(/finished_at < \$1/);
    expect(select).toMatch(/status NOT IN \('QUEUED', 'RUNNING'\)/);
    expect(select).toMatch(/ORDER BY finished_at/);
    expect(statements[0].params).toEqual([cutoff, 100]);
  });

  it('deletes each job\'s uploaded file and report BEFORE the rows that point at them', async () => {
    const { dataSource, storage, order } = setup([[
      { id: 'a', input_object_key: 'in/a', result_object_key: 'out/a' },
      { id: 'b', input_object_key: 'in/b', result_object_key: null },
    ]]);
    const outcome = await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 100, 10);
    expect(outcome).toEqual({ removed: 2, saturated: false });
    expect(order).toEqual(['delete-file:in/a', 'delete-file:out/a', 'delete-file:in/b', 'delete-rows']);
  });

  it('deletes every file of a several-file job (a batch of audit packets), not just the first', async () => {
    const { dataSource, storage, order, statements } = setup([[
      { id: 'batch', input_object_key: null, result_object_key: null, input_objects: [{ key: 'in/1.pdf' }, { key: 'in/2.pdf' }] },
    ]]);
    await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 100, 10);
    expect(order).toEqual(['delete-file:in/1.pdf', 'delete-file:in/2.pdf', 'delete-rows']);
    // The "still used by a younger job" check looks inside the set as well.
    expect(statements.find((s) => s.sql.includes('SELECT 1 AS one'))!.sql).toMatch(/input_objects @>/);
  });

  it('keeps a file a younger job still uses (a commit reuses its rehearsal\'s upload)', async () => {
    const { dataSource, storage } = setup([[{ id: 'rehearsal', input_object_key: 'in/shared', result_object_key: null }]], ['in/shared']);
    await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 100, 10);
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it('carries on when a file cannot be deleted, leaving it to the orphan report', async () => {
    const { dataSource, storage, order } = setup([[{ id: 'a', input_object_key: 'in/a', result_object_key: null }]]);
    storage.deleteFile.mockRejectedValueOnce(new Error('storage unreachable'));
    const warn = jest.fn();
    const outcome = await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 100, 10, warn);
    expect(outcome.removed).toBe(1);
    expect(order).toContain('delete-rows');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('in/a'));
  });

  it('reports saturation when the batch ceiling stopped it, not the data', async () => {
    const full = (n: number, prefix: string): Row[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, input_object_key: null, result_object_key: null }));
    const { dataSource, storage } = setup([full(2, 'a'), full(2, 'b'), full(2, 'c')]);
    expect(await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 2, 2)).toEqual({ removed: 4, saturated: true });
  });

  it('never turns a malformed driver answer into a DELETE', async () => {
    const { dataSource, storage, statements } = setup([[[], 0] as any]);
    expect(await purgeExpiredBackgroundJobs(dataSource as any, storage as any, cutoff, 100, 10)).toEqual({ removed: 0, saturated: false });
    expect(statements.some((s) => s.sql.startsWith('DELETE'))).toBe(false);
  });
});
