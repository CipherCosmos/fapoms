import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  cleanBenchmarkData,
  seedBenchmarkDataset,
  BENCHMARK_TAG,
} from '../src/infrastructure/database/benchmark-harness';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.docker') });

interface SinglePlanMeasurement {
  execMs: number;
  planMs: number;
  rootHitBlocks: number;
  rootReadBlocks: number;
  planNode: string;
  planDetails: any;
}

async function runExplain(ds: DataSource, query: string, params: any[] = []): Promise<SinglePlanMeasurement> {
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`;
  const res = await ds.query(explainSql, params);
  const planObj = res[0]['QUERY PLAN'][0];
  const plan = planObj.Plan;

  return {
    execMs: planObj['Execution Time'],
    planMs: planObj['Planning Time'],
    rootHitBlocks: plan['Shared Hit Blocks'] ?? 0,
    rootReadBlocks: plan['Shared Read Blocks'] ?? 0,
    planNode: plan['Node Type'],
    planDetails: plan,
  };
}

// Helper to extract specific table scan node from plan tree
function findNode(plan: any, condition: (node: any) => boolean): any {
  if (condition(plan)) return plan;
  if (Array.isArray(plan.Plans)) {
    for (const child of plan.Plans) {
      const found = findNode(child, condition);
      if (found) return found;
    }
  }
  return null;
}

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

  console.log('================================================================');
  console.log('Phase 1 Focused Validation & Correction Suite (100,000 rows)');
  console.log('================================================================\n');

  // 1. Seed 100,000 rows deterministically
  console.log('Step 1: Preparing 100k Benchmark Dataset...');
  await cleanBenchmarkData(ds);
  const t0 = Date.now();
  const seedStats = await seedBenchmarkDataset(ds, 100000);
  console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(2)}s:`, seedStats);

  // 2. Profile assayer workload skew
  console.log('\nStep 2: Profiling Assayer Workload Distribution...');
  const assayerDistribution = await ds.query(`
    SELECT assayer_id, count(*)::int as count 
    FROM assignments 
    WHERE is_active = true 
    GROUP BY assayer_id 
    ORDER BY count DESC
  `);
  
  const totalAssayers = assayerDistribution.length;
  const heavyAssayer = assayerDistribution[0];
  const medianAssayer = assayerDistribution[Math.floor(totalAssayers / 2)];
  const lightAssayer = assayerDistribution[totalAssayers - 1];

  console.log(`Total Active Assayers with Workload: ${totalAssayers}`);
  console.log(`- Heavy Assayer:  id=${heavyAssayer.assayer_id}, count=${heavyAssayer.count} (Rank 1 / Top 0.2%)`);
  console.log(`- Median Assayer: id=${medianAssayer.assayer_id}, count=${medianAssayer.count} (Rank ${Math.floor(totalAssayers / 2)} / 50th percentile)`);
  console.log(`- Light Assayer:  id=${lightAssayer.assayer_id}, count=${lightAssayer.count} (Rank ${totalAssayers} / Bottom percentile)`);

  // 3. Reconcile Q1 Benchmark Inconsistencies & Workload Skew (BEFORE Index)
  console.log('\nStep 3: Measuring Q1 (Assayer Mobile Feed) BEFORE candidate index...');
  const testAssayers = [
    { label: 'Heavy Assayer', ...heavyAssayer },
    { label: 'Median Assayer', ...medianAssayer },
    { label: 'Light Assayer', ...lightAssayer },
  ];

  const q1BeforeResults: any[] = [];
  for (const asr of testAssayers) {
    const q1Sql = `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${asr.assayer_id}' AND a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 26`;
    // 3 runs to get stable warm-cache numbers
    const runs: SinglePlanMeasurement[] = [];
    for (let r = 0; r < 3; r++) {
      runs.push(await runExplain(ds, q1Sql));
    }
    const best = runs[2]; // warm run
    q1BeforeResults.push({
      Workload: asr.label,
      Rows: asr.count,
      'Exec (ms)': best.execMs.toFixed(3),
      'Plan (ms)': best.planMs.toFixed(3),
      'Buffers (Hit)': best.rootHitBlocks,
      'Buffers (Read)': best.rootReadBlocks,
      TopNode: best.planNode,
      FilterDetails: best.planDetails.Plans?.[0]?.Filter || 'None',
    });
  }
  console.table(q1BeforeResults);

  // 4. Measure Keyset vs Offset Pagination at Different Depths (Heavy Assayer)
  console.log('\nStep 4: Measuring Keyset vs Offset Pagination Depth (Heavy Assayer)...');
  const paginationDepths = [
    { page: 1, offset: 0 },
    { page: 10, offset: 225 },
    { page: 35, offset: 850 },
  ];

  const paginationResults: any[] = [];
  for (const p of paginationDepths) {
    // Offset Query
    const offsetSql = `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${heavyAssayer.assayer_id}' AND a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 25 OFFSET ${p.offset}`;
    await runExplain(ds, offsetSql); // warm
    const offsetMeas = await runExplain(ds, offsetSql);

    // Keyset Query: get the cursor from the offset point
    const cursorRow = (await ds.query(`SELECT created_at, id FROM assignments WHERE assayer_id = '${heavyAssayer.assayer_id}' AND is_active = true ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ${p.offset}`))[0];
    let keysetMeas: SinglePlanMeasurement;
    if (cursorRow && p.offset > 0) {
      const keysetSql = `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${heavyAssayer.assayer_id}' AND a.is_active = true AND (a.created_at, a.id) < ('${cursorRow.created_at.toISOString()}', '${cursorRow.id}') ORDER BY a.created_at DESC, a.id DESC LIMIT 25`;
      await runExplain(ds, keysetSql);
      keysetMeas = await runExplain(ds, keysetSql);
    } else {
      keysetMeas = offsetMeas;
    }

    paginationResults.push({
      Depth: `Page ${p.page} (Offset ${p.offset})`,
      'Offset Exec (ms)': offsetMeas.execMs.toFixed(3),
      'Offset Buffers': offsetMeas.rootHitBlocks,
      'Keyset Exec (ms)': keysetMeas.execMs.toFixed(3),
      'Keyset Buffers': keysetMeas.rootHitBlocks,
    });
  }
  console.table(paginationResults);

  // 5. Measure Billing Reconciliation (Q6) BEFORE Candidate Index
  console.log('\nStep 5: Measuring Billing Reconciliation (Q6) BEFORE Candidate Index...');
  const q6BoundedSql = `SELECT a.id FROM assignments a LEFT JOIN billing_entries e ON e.assignment_id = a.id LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL WHERE a.status = 'COMPLETED'::assignments_status_enum AND (e.id IS NULL OR p.id IS NULL) AND a.completion_date >= '2026-08-01'::date ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC`;
  const q6UnboundedSql = `SELECT a.id FROM assignments a LEFT JOIN billing_entries e ON e.assignment_id = a.id LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL WHERE a.status = 'COMPLETED'::assignments_status_enum AND (e.id IS NULL OR p.id IS NULL) ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC`;

  await runExplain(ds, q6BoundedSql);
  const q6BoundedBefore = await runExplain(ds, q6BoundedSql);

  await runExplain(ds, q6UnboundedSql);
  const q6UnboundedBefore = await runExplain(ds, q6UnboundedSql);

  // Extract scan breakdown for bounded Q6
  const asgScanBefore = findNode(q6BoundedBefore.planDetails, n => n['Relation Name'] === 'assignments');
  const beScanBefore = findNode(q6BoundedBefore.planDetails, n => n['Relation Name'] === 'billing_entries');
  const apScanBefore = findNode(q6BoundedBefore.planDetails, n => n['Relation Name'] === 'assayer_payables');
  const sortBefore = findNode(q6BoundedBefore.planDetails, n => n['Node Type'] === 'Sort');

  console.log('Q6 Bounded Baseline Breakdown:');
  console.log(`- Full Exec Time: ${q6BoundedBefore.execMs.toFixed(3)} ms | Buffers: ${q6BoundedBefore.rootHitBlocks} hits, ${q6BoundedBefore.rootReadBlocks} reads`);
  console.log(`- Assignments Scan: ${asgScanBefore?.['Node Type']} | Rows Scanned: ${asgScanBefore?.['Actual Rows']} | Time: ${asgScanBefore?.['Actual Total Time']?.toFixed(3)} ms`);
  console.log(`- Billing Entries Scan: ${beScanBefore?.['Node Type']} | Rows Scanned: ${beScanBefore?.['Actual Rows']} | Time: ${beScanBefore?.['Actual Total Time']?.toFixed(3)} ms`);
  console.log(`- Assayer Payables Scan: ${apScanBefore?.['Node Type']} | Rows Scanned: ${apScanBefore?.['Actual Rows']} | Time: ${apScanBefore?.['Actual Total Time']?.toFixed(3)} ms`);
  console.log(`- Sort Method: ${sortBefore?.['Sort Method']} | Sort Space: ${sortBefore?.['Sort Space Used']} kB`);
  console.log(`Q6 Unbounded Baseline: ${q6UnboundedBefore.execMs.toFixed(3)} ms | Buffers: ${q6UnboundedBefore.rootHitBlocks} hits\n`);

  // 6. Create Candidate Indexes and Re-Measure
  console.log('Step 6: Creating Candidate Indexes...');
  console.log('- Creating idx_assignments_assayer_feed...');
  await ds.query(`CREATE INDEX idx_assignments_assayer_feed ON assignments (assayer_id, created_at DESC, id DESC) WHERE is_active = true`);
  console.log('- Creating idx_assignments_completed_reconcile...');
  await ds.query(`CREATE INDEX idx_assignments_completed_reconcile ON assignments (completion_date, created_at) WHERE status = 'COMPLETED'`);
  await ds.query(`ANALYZE assignments`);
  console.log('Indexes created and analyzed.\n');

  // 7. Measure Q1 AFTER Index
  console.log('Step 7: Measuring Q1 AFTER idx_assignments_assayer_feed...');
  const q1AfterResults: any[] = [];
  for (const asr of testAssayers) {
    const q1Sql = `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${asr.assayer_id}' AND a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 26`;
    const runs: SinglePlanMeasurement[] = [];
    for (let r = 0; r < 3; r++) {
      runs.push(await runExplain(ds, q1Sql));
    }
    const best = runs[2];
    q1AfterResults.push({
      Workload: asr.label,
      Rows: asr.count,
      'Exec (ms)': best.execMs.toFixed(3),
      'Plan (ms)': best.planMs.toFixed(3),
      'Buffers (Hit)': best.rootHitBlocks,
      'Buffers (Read)': best.rootReadBlocks,
      TopNode: best.planNode,
      IndexCond: best.planDetails.Plans?.[0]?.['Index Cond'] || 'Direct Index Scan',
    });
  }
  console.table(q1AfterResults);

  // 8. Measure Q6 AFTER Index
  console.log('\nStep 8: Measuring Billing Reconciliation (Q6) AFTER idx_assignments_completed_reconcile...');
  await runExplain(ds, q6BoundedSql);
  const q6BoundedAfter = await runExplain(ds, q6BoundedSql);

  await runExplain(ds, q6UnboundedSql);
  const q6UnboundedAfter = await runExplain(ds, q6UnboundedSql);

  const asgScanAfter = findNode(q6BoundedAfter.planDetails, n => n['Relation Name'] === 'assignments');
  const beScanAfter = findNode(q6BoundedAfter.planDetails, n => n['Relation Name'] === 'billing_entries');
  const apScanAfter = findNode(q6BoundedAfter.planDetails, n => n['Relation Name'] === 'assayer_payables');
  const sortAfter = findNode(q6BoundedAfter.planDetails, n => n['Node Type'] === 'Sort');

  console.log('Q6 Bounded AFTER Index Breakdown:');
  console.log(`- Full Exec Time: ${q6BoundedAfter.execMs.toFixed(3)} ms (vs ${q6BoundedBefore.execMs.toFixed(3)} ms before)`);
  console.log(`- Assignments Scan: ${asgScanAfter?.['Node Type']} using ${asgScanAfter?.Plans?.[0]?.['Index Name'] || 'index'} | Time: ${asgScanAfter?.['Actual Total Time']?.toFixed(3)} ms`);
  console.log(`- Billing Entries Scan: ${beScanAfter?.['Node Type']} | Rows Scanned: ${beScanAfter?.['Actual Rows']} | Time: ${beScanAfter?.['Actual Total Time']?.toFixed(3)} ms`);
  console.log(`- Assayer Payables Scan: ${apScanAfter?.['Node Type']} | Rows Scanned: ${apScanAfter?.['Actual Rows']} | Time: ${apScanAfter?.['Actual Total Time']?.toFixed(3)} ms`);
  console.log(`- Sort Method: ${sortAfter?.['Sort Method']} | Sort Space: ${sortAfter?.['Sort Space Used']} kB`);
  console.log(`Q6 Unbounded AFTER Index: ${q6UnboundedAfter.execMs.toFixed(3)} ms (Note: Unbounded sweeps scan entire table, index not used)\n`);

  // 9. Measure Actual Write Overhead Across Lifecycle Events
  console.log('Step 9: Measuring Index Write Overhead Across Assignment Lifecycle...');
  const sampleProject = (await ds.query(`SELECT id FROM projects LIMIT 1`))[0].id;
  const samplePB = (await ds.query(`SELECT id FROM project_branches LIMIT 1`))[0].id;

  // A. INSERT 1,000 PENDING assignments (Should NOT touch idx_assignments_completed_reconcile)
  const pendingBatch: string[] = [];
  for (let i = 0; i < 1000; i++) {
    pendingBatch.push(`('${uuidv4()}', NOW(), NOW(), 1, true, 'TEST-W-INS-${i}', '${sampleProject}', '${samplePB}', '${heavyAssayer.assayer_id}', 'PENDING', 'MEDIUM', CURRENT_DATE, 'BENCHMARK_WRITE_TEST')`);
  }
  const tIns0 = Date.now();
  await ds.query(`INSERT INTO assignments (id, created_at, updated_at, version, is_active, assignment_number, project_id, project_branch_id, assayer_id, status, priority, scheduled_date, sync_token) VALUES ${pendingBatch.join(', ')}`);
  const tInsMs = Date.now() - tIns0;
  console.log(`- Insert 1,000 PENDING assignments (NOT indexed in partial index): ${tInsMs} ms (${(tInsMs / 1000).toFixed(3)} ms/row)`);

  // B. UPDATE 1,000 assignments to COMPLETED (MUST insert entries into idx_assignments_completed_reconcile)
  const tUpdComp0 = Date.now();
  await ds.query(`UPDATE assignments SET status = 'COMPLETED', completion_date = CURRENT_DATE WHERE sync_token = 'BENCHMARK_WRITE_TEST'`);
  const tUpdCompMs = Date.now() - tUpdComp0;
  console.log(`- Transition 1,000 to COMPLETED (enters partial index): ${tUpdCompMs} ms (${(tUpdCompMs / 1000).toFixed(3)} ms/row)`);

  // C. UPDATE completion_date on COMPLETED (modifies index tree)
  const tUpdDate0 = Date.now();
  await ds.query(`UPDATE assignments SET completion_date = CURRENT_DATE - 1 WHERE sync_token = 'BENCHMARK_WRITE_TEST'`);
  const tUpdDateMs = Date.now() - tUpdDate0;
  console.log(`- Update completion_date on 1,000 COMPLETED rows (index re-key): ${tUpdDateMs} ms (${(tUpdDateMs / 1000).toFixed(3)} ms/row)`);

  // D. Transition out of COMPLETED -> CANCELLED (deletes from partial index)
  const tUpdCancel0 = Date.now();
  await ds.query(`UPDATE assignments SET status = 'CANCELLED' WHERE sync_token = 'BENCHMARK_WRITE_TEST'`);
  const tUpdCancelMs = Date.now() - tUpdCancel0;
  console.log(`- Transition 1,000 out of COMPLETED to CANCELLED (removes from partial index): ${tUpdCancelMs} ms (${(tUpdCancelMs / 1000).toFixed(3)} ms/row)`);

  // Clean up test batch
  await ds.query(`DELETE FROM assignments WHERE sync_token = 'BENCHMARK_WRITE_TEST'`);

  // 10. Audit Session-Dependent Features
  console.log('\nStep 10: Auditing Session-Dependent Features for PgBouncer...');
  const advisoryLocks = await ds.query(`SELECT objid, mode, granted FROM pg_locks WHERE locktype = 'advisory'`);
  console.log(`- Active PostgreSQL Advisory Locks: ${advisoryLocks.length}`);

  // Drop candidate indexes before exit to restore clean migration state
  console.log('\nStep 11: Restoring clean state...');
  await ds.query(`DROP INDEX IF EXISTS idx_assignments_assayer_feed`);
  await ds.query(`DROP INDEX IF EXISTS idx_assignments_completed_reconcile`);
  await cleanBenchmarkData(ds);
  console.log('Clean complete.');

  await ds.destroy();
}

main().catch(err => {
  console.error('Validation script error:', err);
  process.exit(1);
});
