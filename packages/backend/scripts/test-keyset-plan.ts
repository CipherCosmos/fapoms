import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  cleanBenchmarkData,
  seedBenchmarkDataset,
} from '../src/infrastructure/database/benchmark-harness';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.docker') });

async function main() {
  const host = process.env.DB_HOST === 'postgres' ? 'localhost' : (process.env.DB_HOST || 'localhost');
  const ds = new DataSource({
    type: 'postgres',
    host,
    port: parseInt(process.env.DB_PORT || '5432'),
    username: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD || 'fapoms_dev',
    database: process.env.DB_DATABASE || 'fapoms',
  });
  await ds.initialize();

  console.log('Seeding 100k rows...');
  await cleanBenchmarkData(ds);
  await seedBenchmarkDataset(ds, 100000);

  console.log('Creating idx_assignments_assayer_feed...');
  await ds.query(`CREATE INDEX IF NOT EXISTS idx_assignments_assayer_feed ON assignments (assayer_id, created_at DESC, id DESC) WHERE is_active = true`);
  console.log('Creating idx_assignments_completed_reconcile...');
  await ds.query(`CREATE INDEX IF NOT EXISTS idx_assignments_completed_reconcile ON assignments (completion_date, created_at) WHERE status = 'COMPLETED'`);
  await ds.query(`ANALYZE assignments, billing_entries, assayer_payables`);

  const heavyAssayer = (await ds.query(`SELECT assayer_id, count(*) FROM assignments WHERE is_active = true GROUP BY assayer_id ORDER BY count(*) DESC LIMIT 1`))[0].assayer_id;
  console.log(`Heavy assayer: ${heavyAssayer}`);

  // Fetch page 1 to get cursor for page 2, 10, 35, 50
  const allRows = await ds.query(`SELECT id, created_at FROM assignments WHERE assayer_id = '${heavyAssayer}' AND is_active = true ORDER BY created_at DESC, id DESC`);
  console.log(`Total rows for heavy assayer: ${allRows.length}`);

  const pageDepths = [
    { page: 1, offset: 0 },
    { page: 10, offset: 9 * 25 },
    { page: 35, offset: 34 * 25 },
    { page: 50, offset: Math.min(allRows.length - 26, 49 * 25) },
  ];

  console.log('\n--- TESTING KEYSET PAGINATION WITH INDEX PRESENT ---');
  for (const p of pageDepths) {
    const cursor = allRows[p.offset];
    const cursorDate = cursor.created_at.toISOString();
    const cursorId = cursor.id;

    // Tuple syntax: (a.created_at, a.id) < ($1, $2)
    const tupleSql = p.page === 1
      ? `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${heavyAssayer}' AND a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 26`
      : `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${heavyAssayer}' AND a.is_active = true AND (a.created_at, a.id) < ('${cursorDate}', '${cursorId}') ORDER BY a.created_at DESC, a.id DESC LIMIT 26`;

    // Disjunctive syntax: a.created_at < $1 OR (a.created_at = $1 AND a.id < $2)
    const disjSql = p.page === 1
      ? tupleSql
      : `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${heavyAssayer}' AND a.is_active = true AND (a.created_at < '${cursorDate}' OR (a.created_at = '${cursorDate}' AND a.id < '${cursorId}')) ORDER BY a.created_at DESC, a.id DESC LIMIT 26`;

    // Standard Offset Query
    const offsetSql = `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${heavyAssayer}' AND a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 25 OFFSET ${p.offset}`;

    // Warm-up and measure
    await ds.query(`EXPLAIN (ANALYZE, BUFFERS) ${tupleSql}`);
    const tupleRes = await ds.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${tupleSql}`);
    const tuplePlan = tupleRes[0]['QUERY PLAN'][0];

    await ds.query(`EXPLAIN (ANALYZE, BUFFERS) ${disjSql}`);
    const disjRes = await ds.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${disjSql}`);
    const disjPlan = disjRes[0]['QUERY PLAN'][0];

    await ds.query(`EXPLAIN (ANALYZE, BUFFERS) ${offsetSql}`);
    const offsetRes = await ds.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${offsetSql}`);
    const offsetPlan = offsetRes[0]['QUERY PLAN'][0];

    console.log(`\n=== PAGE ${p.page} (Offset ${p.offset}) ===`);
    console.log(`Tuple Keyset:  Exec=${tuplePlan['Execution Time'].toFixed(3)}ms, Buffers=${tuplePlan.Plan['Shared Hit Blocks']} hits, Node=${tuplePlan.Plan['Node Type']}, Index=${tuplePlan.Plan.Plans?.[0]?.['Index Name']}, IndexCond=${tuplePlan.Plan.Plans?.[0]?.['Index Cond']}, FilterRemoved=${tuplePlan.Plan.Plans?.[0]?.['Rows Removed by Filter'] ?? 0}`);
    console.log(`Disj Keyset:   Exec=${disjPlan['Execution Time'].toFixed(3)}ms, Buffers=${disjPlan.Plan['Shared Hit Blocks']} hits, Node=${disjPlan.Plan['Node Type']}, Index=${disjPlan.Plan.Plans?.[0]?.['Index Name']}, IndexCond=${disjPlan.Plan.Plans?.[0]?.['Index Cond']}, FilterRemoved=${disjPlan.Plan.Plans?.[0]?.['Rows Removed by Filter'] ?? 0}`);
    console.log(`Offset Paging: Exec=${offsetPlan['Execution Time'].toFixed(3)}ms, Buffers=${offsetPlan.Plan['Shared Hit Blocks']} hits, Node=${offsetPlan.Plan['Node Type']}, Index=${offsetPlan.Plan.Plans?.[0]?.['Index Name']}`);
  }

  // Next: Benchmark Reconciliation Query A vs Query B
  console.log('\n=============================================================');
  console.log('--- RECONCILIATION BENCHMARK: QUERY A (LEFT JOIN) vs QUERY B (UNION) ---');
  console.log('=============================================================');

  const qA = `
    SELECT a.id, a.completion_date, a.created_at
    FROM assignments a
    LEFT JOIN billing_entries e ON e.assignment_id = a.id
    LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL
    WHERE a.status = 'COMPLETED'::assignments_status_enum
      AND (e.id IS NULL OR p.id IS NULL)
      AND a.completion_date >= '2026-08-01'::date
    ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC;
  `;

  const qB = `
    (
      SELECT a.id, a.completion_date, a.created_at
      FROM assignments a
      WHERE a.status = 'COMPLETED'::assignments_status_enum
        AND a.completion_date >= '2026-08-01'::date
        AND NOT EXISTS (SELECT 1 FROM billing_entries e WHERE e.assignment_id = a.id)
    )
    UNION
    (
      SELECT a.id, a.completion_date, a.created_at
      FROM assignments a
      WHERE a.status = 'COMPLETED'::assignments_status_enum
        AND a.completion_date >= '2026-08-01'::date
        AND NOT EXISTS (SELECT 1 FROM assayer_payables p WHERE p.assignment_id = a.id AND p.expense_id IS NULL)
    )
    ORDER BY completion_date ASC NULLS LAST, created_at ASC;
  `;

  // 3 warm runs for each
  for (let i = 0; i < 3; i++) {
    await ds.query(`EXPLAIN (ANALYZE, BUFFERS) ${qA}`);
    await ds.query(`EXPLAIN (ANALYZE, BUFFERS) ${qB}`);
  }

  const resA = (await ds.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${qA}`))[0]['QUERY PLAN'][0];
  const resB = (await ds.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${qB}`))[0]['QUERY PLAN'][0];

  function sumBuffers(node: any): { hit: number; read: number } {
    const s = { hit: node['Shared Hit Blocks'] || 0, read: node['Shared Read Blocks'] || 0 };
    if (Array.isArray(node.Plans)) {
      for (const c of node.Plans) {
        const cs = sumBuffers(c);
        s.hit += cs.hit;
        s.read += cs.read;
      }
    }
    return s;
  }

  const bufA = sumBuffers(resA.Plan);
  const bufB = sumBuffers(resB.Plan);

  console.log('\n--- Query A: Current LEFT JOIN with OR (e.id IS NULL OR p.id IS NULL) ---');
  console.log(`Execution Time: ${resA['Execution Time'].toFixed(3)} ms`);
  console.log(`Planning Time:  ${resA['Planning Time'].toFixed(3)} ms`);
  console.log(`Root Buffers:   Hit=${resA.Plan['Shared Hit Blocks'] || 0}, Read=${resA.Plan['Shared Read Blocks'] || 0}`);
  console.log(`Total Buffers:  Hit=${bufA.hit}, Read=${bufA.read}`);
  console.log(`Top Node:       ${resA.Plan['Node Type']}`);

  console.log('\n--- Query B: Logically Equivalent UNION of Anti-Joins ---');
  console.log(`Execution Time: ${resB['Execution Time'].toFixed(3)} ms`);
  console.log(`Planning Time:  ${resB['Planning Time'].toFixed(3)} ms`);
  console.log(`Root Buffers:   Hit=${resB.Plan['Shared Hit Blocks'] || 0}, Read=${resB.Plan['Shared Read Blocks'] || 0}`);
  console.log(`Total Buffers:  Hit=${bufB.hit}, Read=${bufB.read}`);
  console.log(`Top Node:       ${resB.Plan['Node Type']}`);

  await cleanBenchmarkData(ds);
  await ds.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
