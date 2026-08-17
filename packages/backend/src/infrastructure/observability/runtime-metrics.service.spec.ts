import { Registry } from 'prom-client';
import { RuntimeMetricsService } from './runtime-metrics.service';
import { MetricsService } from './metrics.service';

/**
 * The statement gauges exist to answer "which query got slower?", and the two ways they can fail
 * are both silent by construction:
 *
 *   1. The extension is not loaded. Reading the view then raises 55000, and a sampler that let
 *      that propagate would take the pool and queue gauges down with it — losing every metric at
 *      the exact moment somebody is trying to diagnose the database.
 *   2. The extension IS loaded but the panel is empty. On a dashboard that is indistinguishable
 *      from a database with nothing slow on it, which is why availability is its own series.
 *
 * The third thing worth pinning down is cardinality: pg_stat_statements holds up to 5,000 rows,
 * and exporting them all would be 15,000 series per replica for a question answered by the first
 * page. The LIMIT is the cardinality budget and a test should notice if it is ever removed.
 */

/** A MetricsService with its own registry, so each test starts from an empty metric namespace. */
function makeMetrics(): MetricsService {
  return { registry: new Registry() } as unknown as MetricsService;
}

function makeService(query: jest.Mock) {
  const metrics = makeMetrics();
  const dataSource: any = { query, driver: { master: {} } };
  const service = new RuntimeMetricsService(metrics, dataSource, undefined);
  return { service, registry: metrics.registry };
}

const ROW = (over: Partial<Record<string, unknown>> = {}) => ({
  queryid: '-2740639895694263400',
  statement: 'SELECT * FROM assignments WHERE status = $1',
  calls: 120,
  total_exec_ms: 2400,
  mean_exec_ms: 20,
  tracked: 137,
  ...over,
});

describe('RuntimeMetricsService — statement statistics', () => {
  it('exports the top statements with time converted to seconds', async () => {
    const query = jest.fn().mockResolvedValue([ROW()]);
    const { registry } = makeService(query);

    const text = await registry.metrics();

    // Postgres reports milliseconds; Prometheus convention is base units.
    expect(text).toContain('db_query_exec_seconds_total{queryid="-2740639895694263400"');
    expect(text).toMatch(/db_query_exec_seconds_total\{[^}]*\} 2\.4\b/);
    expect(text).toMatch(/db_query_mean_exec_seconds\{[^}]*\} 0\.02\b/);
    expect(text).toMatch(/db_query_calls_total\{[^}]*\} 120\b/);
    expect(text).toContain('db_query_stats_available 1');
    expect(text).toContain('db_query_stats_tracked 137');
  });

  it('caps the number of exported statements, so 5,000 tracked queries cannot become 5,000 series', async () => {
    // Whatever the LIMIT is, it must be bound in SQL rather than filtered in JS — a top-N applied
    // after fetching 5,000 rows would still drag the whole view over the wire on every scrape.
    const query = jest.fn().mockResolvedValue([ROW()]);
    const { registry } = makeService(query);
    await registry.metrics();

    const [sql, params] = query.mock.calls.at(-1)!;
    expect(sql).toMatch(/ORDER BY s\.total_exec_time DESC/i);
    expect(sql).toMatch(/LIMIT \$1/);
    expect(params[0]).toBeLessThanOrEqual(50);
  });

  it('only exports normalised DML, so no literal can reach a Prometheus label', async () => {
    // pg_stat_statements records utility commands verbatim (track_utility defaults on), and this
    // repo runs `ALTER ROLE … PASSWORD …` inside the container during password rotation. The
    // allowlist of statement shapes is the boundary that keeps that out of the metrics store.
    const query = jest.fn().mockResolvedValue([]);
    const { registry } = makeService(query);
    await registry.metrics();

    const [sql] = query.mock.calls.at(-1)!;
    expect(sql).toMatch(/\^\\s\*\(select\|insert\|update\|delete\|with\)/i);
    // Cluster-wide view: the scale-test database must not dominate the application's ranking.
    expect(sql).toMatch(/current_database\(\)/);
  });

  it('collapses the SELECT projection so TypeORM aliases do not fill the label', async () => {
    // Measured against the dev database: without this, the top three statements all rendered as
    // `SELECT "UserEntity"."id" AS "UserEntity_id", "UserEntity"."created_by" AS "UserE` — three
    // different queries, one indistinguishable label. The table and predicate are what identify
    // a query; the alias list is what crowds them out.
    const query = jest.fn().mockResolvedValue([]);
    const { registry } = makeService(query);
    await registry.metrics();

    const [sql] = query.mock.calls.at(-1)!;
    expect(sql).toMatch(/'\^SELECT \.\+\? FROM '/);
  });

  it('reports unavailable instead of throwing when the extension is not loaded', async () => {
    // The real error: SQLSTATE 55000 from a postmaster that was never restarted with the preload.
    const query = jest.fn().mockRejectedValue(
      Object.assign(new Error('pg_stat_statements must be loaded via shared_preload_libraries'), {
        code: '55000',
      }),
    );
    const { registry } = makeService(query);

    const text = await registry.metrics();

    expect(text).toContain('db_query_stats_available 0');
    // Every other metric still had to be produced — a broken diagnostic must not blind the rest.
    expect(text).toContain('db_pool_connections');
    // And the statement series are absent rather than present-and-zero: a zero would read as
    // "this query is instant", which is a worse lie than no data.
    expect(text).not.toMatch(/^db_query_exec_seconds_total\{/m);
  });

  it('backs off after a failure rather than issuing a doomed query on every scrape', async () => {
    // shared_preload_libraries is PGC_POSTMASTER, so nothing this process does can make the next
    // attempt succeed. Retrying every 15 seconds forever would be pure noise in the Postgres log.
    const query = jest.fn().mockRejectedValue(new Error('relation "pg_stat_statements" does not exist'));
    const { registry } = makeService(query);

    await registry.metrics();
    const afterFirst = query.mock.calls.length;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000); // past the sample TTL
    await registry.metrics();
    jest.restoreAllMocks();

    expect(query.mock.calls.length).toBe(afterFirst);
  });

  it('issues one query per scrape however many gauges read the sample', async () => {
    // Five gauges share one sample. Without the memo, prom-client's concurrent collection would
    // make the observability endpoint the heaviest database client in the process.
    const query = jest.fn().mockResolvedValue([ROW()]);
    const { registry } = makeService(query);

    await registry.metrics();

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('drops a statement that falls out of the top N instead of freezing its last value', async () => {
    // prom-client remembers every label set it is given. Without reset(), a query that stops
    // being slow keeps reporting the value it had when it was — a series that never moves again
    // and reads as a query still burning time.
    const query = jest
      .fn()
      .mockResolvedValueOnce([ROW({ queryid: '111', statement: 'SELECT 1' })])
      .mockResolvedValueOnce([ROW({ queryid: '222', statement: 'SELECT 2' })]);
    const { registry } = makeService(query);

    await registry.metrics();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000); // past the sample TTL
    const second = await registry.metrics();
    jest.restoreAllMocks();

    expect(second).toContain('queryid="222"');
    expect(second).not.toContain('queryid="111"');
  });
});
