import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  cleanBenchmarkData,
  seedBenchmarkDataset,
  explainQuery,
} from '../src/infrastructure/database/benchmark-harness';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.docker') });

async function run() {
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

  const targetSize = parseInt(process.argv[2] || '10000');
  console.log(`\n======================================================`);
  console.log(`Phase 1 Benchmark Suite — Dataset Size: ${targetSize} rows`);
  console.log(`======================================================\n`);

  console.log('1. Cleaning existing benchmark data...');
  await cleanBenchmarkData(ds);
  console.log('Clean complete.');

  console.log(`2. Seeding deterministic dataset with ${targetSize} assignments...`);
  const t0 = Date.now();
  const seeded = await seedBenchmarkDataset(ds, targetSize);
  console.log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(2)}s:`, seeded);

  // Pick sample entities for parameterized queries
  const topAssayerRow = (await ds.query(`SELECT assayer_id FROM assignments GROUP BY assayer_id ORDER BY count(*) DESC LIMIT 1`))[0];
  const sampleAssayer = topAssayerRow ? topAssayerRow.assayer_id : (await ds.query(`SELECT id FROM assayers WHERE region IS NOT NULL LIMIT 1`))[0].id;
  const sampleClient = (await ds.query(`SELECT id FROM clients LIMIT 1`))[0].id;
  const sampleOrg = '76ac6784-8600-4dac-bd7a-c7858eeb1b8a';

  const queries = [
    {
      name: 'Q1: Assayer Mobile Feed (Keyset/Order)',
      sql: `SELECT a.id, a.created_at, a.status FROM assignments a WHERE a.assayer_id = '${sampleAssayer}' AND a.is_active = true ORDER BY a.created_at DESC, a.id DESC LIMIT 26`,
    },
    {
      name: 'Q2: Operations Page (Offset 50)',
      sql: `SELECT a.id, a.created_at FROM assignments a WHERE a.is_active = true ORDER BY a.created_at DESC, a.id ASC LIMIT 25 OFFSET 50`,
    },
    {
      name: 'Q3: Operations Status Filter (PENDING)',
      sql: `SELECT a.id, a.created_at FROM assignments a WHERE a.is_active = true AND a.status = 'PENDING'::assignments_status_enum ORDER BY a.created_at DESC, a.id ASC LIMIT 25`,
    },
    {
      name: 'Q4: Falling Behind SLA Sweep',
      sql: `SELECT a.id FROM assignments a WHERE a.is_active = true AND a.status IN ('PENDING'::assignments_status_enum, 'ACCEPTED'::assignments_status_enum, 'CHECKED_IN'::assignments_status_enum, 'IN_PROGRESS'::assignments_status_enum) AND (a.sla_status = 'BREACHED' OR a.sla_due_date < NOW()) LIMIT 50`,
    },
    {
      name: 'Q5: Unscheduled Only (NOT EXISTS schedule)',
      sql: `SELECT a.id FROM assignments a WHERE a.is_active = true AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.assignment_id = a.id AND s.is_active = true) LIMIT 25`,
    },
    {
      name: 'Q6: Billing Reconciliation (Missing Legs)',
      sql: `SELECT a.id FROM assignments a LEFT JOIN billing_entries e ON e.assignment_id = a.id LEFT JOIN assayer_payables p ON p.assignment_id = a.id AND p.expense_id IS NULL WHERE a.status = 'COMPLETED'::assignments_status_enum AND (e.id IS NULL OR p.id IS NULL) ORDER BY a.completion_date ASC NULLS LAST, a.created_at ASC`,
    },
    {
      name: 'Q7: Assayer Double-Booking Check',
      sql: `SELECT a.id FROM assignments a WHERE a.assayer_id = '${sampleAssayer}' AND a.scheduled_date = CURRENT_DATE AND a.status = 'ACCEPTED'::assignments_status_enum AND a.is_active = true`,
    },
    {
      name: 'Q8: Tenant Scoped Branch Query',
      sql: `SELECT b.id, b.name, b.sol_id, b.region FROM branches b WHERE b.organization_id = '${sampleOrg}' AND b.client_id = '${sampleClient}' AND b.region = 'WEST' AND b.is_active = true ORDER BY b.created_at DESC LIMIT 50`,
    },
  ];

  console.log('\n3. Executing EXPLAIN (ANALYZE, BUFFERS) across hot queries...');
  const results = [];
  for (const q of queries) {
    // Warm-up run
    await explainQuery(ds, q.sql);
    // Measured run
    const m = await explainQuery(ds, q.sql);
    results.push({
      Query: q.name,
      'Exec (ms)': m.executionTimeMs.toFixed(3),
      'Plan (ms)': m.planningTimeMs.toFixed(3),
      'Hit Blocks': m.sharedHitBlocks,
      'Read Blocks': m.sharedReadBlocks,
      'Est Rows': m.rowsEstimated,
      'Act Rows': m.rowsActual,
      Scan: m.scanType,
    });
  }

  console.table(results);

  await ds.destroy();
}

run().catch((err) => {
  console.error('Benchmark runner error:', err);
  process.exit(1);
});
