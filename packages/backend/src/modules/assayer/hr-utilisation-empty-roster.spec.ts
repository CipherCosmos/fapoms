import { HrWorkforceService } from './hr-workforce.service';

/**
 * AN EMPTY ROSTER HAS DONE ZERO WORK, NOT "NULL" WORK.
 *
 * The performance totals were plain `SUM(...)`, which Postgres answers with NULL over no rows (a
 * new organisation, or a region desk whose scope holds nobody). The Utilisation page's "nobody has
 * been given work yet" explainer compares `totalAssignments === 0`, so it never showed, and the
 * screen fell back to accusing everybody of being idle.
 */
describe('HR utilisation over an empty roster', () => {
  it('sums with COALESCE so every performance total is a number', async () => {
    const seen: string[] = [];
    const query = jest.fn(async (sql: string) => {
      seen.push(sql);
      if (sql.includes('AS "totalAssignments"') && sql.includes('AVG(')) {
        // What Postgres returns for a SUM over no rows if the SQL does not COALESCE.
        return [{ totalAssignments: sql.includes('COALESCE(SUM(total_assignments), 0)') ? 0 : null }];
      }
      return [];
    });
    const service = new HrWorkforceService({ query } as any, { wrap: async (_k: string, _t: number, fn: any) => fn(), del: jest.fn() } as any,
      { subscribe: jest.fn(), publish: jest.fn() } as any);
    const result: any = await (service as any).utilisation();
    expect(result.performance.totalAssignments).toBe(0);
    const perf = seen.find((s) => s.includes('AVG(NULLIF(average_rating'))!;
    for (const col of ['total_assignments', 'completed_assignments', 'cancelled_assignments', 'on_time_completions']) {
      expect(perf).toContain(`COALESCE(SUM(${col}), 0)`);
    }
  });
});
