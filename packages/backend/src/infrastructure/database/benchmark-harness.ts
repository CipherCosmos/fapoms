import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

/**
 * Deterministic Benchmark Harness for Phase 1 Database & Query Scalability
 *
 * Provides repeatable, isolated, and safely resettable operational datasets
 * with realistic statistical distributions (skewed status, power-law assayer workload,
 * billing backlog, completion date windows).
 */

export const BENCHMARK_TAG = 'BENCHMARK_V1';

// Deterministic PRNG: Mulberry32
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BenchmarkMetrics {
  queryName: string;
  planningTimeMs: number;
  executionTimeMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  rowsEstimated: number;
  rowsActual: number;
  scanType: string;
  planTree: any;
}

export async function cleanBenchmarkData(ds: DataSource): Promise<void> {
  // Ordered cleanup to satisfy foreign keys
  await ds.query(`DELETE FROM billing_history WHERE assignment_id IN (SELECT id FROM assignments WHERE sync_token = '${BENCHMARK_TAG}')`);
  await ds.query(`DELETE FROM assayer_payables WHERE assignment_id IN (SELECT id FROM assignments WHERE sync_token = '${BENCHMARK_TAG}')`);
  await ds.query(`DELETE FROM billing_entries WHERE assignment_id IN (SELECT id FROM assignments WHERE sync_token = '${BENCHMARK_TAG}')`);
  await ds.query(`DELETE FROM assignments WHERE sync_token = '${BENCHMARK_TAG}'`);
  await ds.query(`DELETE FROM project_branches WHERE created_by = '${BENCHMARK_TAG}' OR project_id IN (SELECT id FROM projects WHERE created_by = '${BENCHMARK_TAG}')`);
  await ds.query(`DELETE FROM branches WHERE created_by = '${BENCHMARK_TAG}'`);
  await ds.query(`DELETE FROM projects WHERE created_by = '${BENCHMARK_TAG}'`);
  await ds.query(`ANALYZE assignments, billing_entries, assayer_payables, branches, projects, project_branches`);
}

export async function seedBenchmarkDataset(ds: DataSource, targetAssignments = 10000): Promise<{
  projectCount: number;
  branchCount: number;
  assignmentCount: number;
  billingEntryCount: number;
  assayerPayableCount: number;
}> {
  const rand = mulberry32(0x1a2b3c4d); // Fixed seed for 100% reproducibility

  // Retrieve existing org, clients, and assayers
  const orgRow = (await ds.query(`SELECT id FROM organizations LIMIT 1`))[0];
  const orgId = orgRow ? orgRow.id : '76ac6784-8600-4dac-bd7a-c7858eeb1b8a';

  const clients = await ds.query(`SELECT id, client_code FROM clients LIMIT 5`);
  const clientIds = clients.map((c: any) => c.id);
  if (clientIds.length === 0) throw new Error('No clients found to associate with benchmark');

  const assayers = await ds.query(`SELECT id, region FROM assayers WHERE region IS NOT NULL LIMIT 500`);
  const assayerIds = assayers.map((a: any) => a.id);
  if (assayerIds.length === 0) throw new Error('No assayers found to associate with benchmark');

  // 1. Seed Projects (5 benchmark projects)
  const projectIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const pId = uuidv4();
    projectIds.push(pId);
    const clientId = clientIds[i % clientIds.length];
    await ds.query(
      `INSERT INTO projects (
        id, created_at, updated_at, version, is_active,
        project_number, name, client_id, status, priority,
        organization_id, created_by
      ) VALUES (
        $1, NOW(), NOW(), 1, true,
        $2, $3, $4, 'EXECUTION'::projects_status_enum, 'HIGH'::projects_priority_enum,
        $5, '${BENCHMARK_TAG}'
      ) ON CONFLICT (id) DO NOTHING`,
      [pId, `BM-PRJ-${i}`, `Benchmark Project ${i}`, clientId, orgId],
    );
  }

  // 2. Seed Branches (50 benchmark branches across 5 regions)
  const regions = ['WEST', 'SOUTH', 'NORTH', 'EAST', 'CENTRAL'];
  const branchIds: string[] = [];
  for (let i = 1; i <= 50; i++) {
    const bId = uuidv4();
    branchIds.push(bId);
    const region = regions[i % regions.length];
    const clientId = clientIds[i % clientIds.length];
    await ds.query(
      `INSERT INTO branches (
        id, created_at, updated_at, version, is_active,
        sol_id, name, address, state, district, city,
        region, client_id, organization_id, created_by,
        risk_score, complexity, estimated_duration_hours
      ) VALUES (
        $1, NOW(), NOW(), 1, true,
        $2, $3, $4, $5, $6, $7,
        $8, $9, $10, '${BENCHMARK_TAG}',
        10, 'LOW', 2
      ) ON CONFLICT (id) DO NOTHING`,
      [bId, `SOL-${1000 + i}`, `Benchmark Branch ${i}`, `Address ${i}`, `State-${region}`, `District-${i}`, `City-${i}`, region, clientId, orgId],
    );
  }

  // 3. Seed Project Branches
  const projectBranchIds: string[] = [];
  for (let i = 0; i < branchIds.length; i++) {
    const pbId = uuidv4();
    projectBranchIds.push(pbId);
    const pId = projectIds[i % projectIds.length];
    const bId = branchIds[i];
    await ds.query(
      `INSERT INTO project_branches (
        id, created_at, updated_at, version, is_active,
        project_id, branch_id, status, priority, created_by, remarks
      ) VALUES (
        $1, NOW(), NOW(), 1, true,
        $2, $3, 'IMPORTED', 'MEDIUM', '${BENCHMARK_TAG}', '${BENCHMARK_TAG}'
      ) ON CONFLICT (id) DO NOTHING`,
      [pbId, pId, bId],
    );
  }

  // 4. Generate Assignments in Batches of 1,000
  const BATCH_SIZE = 1000;
  let insertedAssignments = 0;
  let insertedBillingEntries = 0;
  let insertedPayables = 0;

  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (let batchStart = 0; batchStart < targetAssignments; batchStart += BATCH_SIZE) {
    const currentBatchSize = Math.min(BATCH_SIZE, targetAssignments - batchStart);
    const assignmentRows: any[] = [];
    const billingRows: any[] = [];
    const payableRows: any[] = [];

    for (let j = 0; j < currentBatchSize; j++) {
      const idx = batchStart + j;
      const asgId = uuidv4();
      const asgNumber = `BM-ASG-${idx.toString().padStart(7, '0')}`;
      
      // Status Skew: 65% COMPLETED, 15% IN_PROGRESS/ACCEPTED, 10% PENDING, 5% CANCELLED, 5% REJECTED
      const rStatus = rand();
      let status = 'COMPLETED';
      let slaStatus = 'COMPLIANT';
      if (rStatus < 0.65) {
        status = 'COMPLETED';
      } else if (rStatus < 0.75) {
        status = 'IN_PROGRESS';
      } else if (rStatus < 0.80) {
        status = 'ACCEPTED';
      } else if (rStatus < 0.90) {
        status = 'PENDING';
        slaStatus = rand() < 0.2 ? 'BREACHED' : 'COMPLIANT';
      } else if (rStatus < 0.95) {
        status = 'CANCELLED';
      } else {
        status = 'REJECTED';
      }

      // 95% Active, 5% Inactive
      const isActive = rand() > 0.05;

      // Completion & Scheduled Dates
      const daysAgo = Math.floor(rand() * 180); // within last 180 days
      const scheduledDate = new Date(nowMs - (daysAgo + 2) * dayMs).toISOString().split('T')[0];
      const completionDate = status === 'COMPLETED' ? new Date(nowMs - daysAgo * dayMs).toISOString().split('T')[0] : null;
      const createdAt = new Date(nowMs - (daysAgo + 5) * dayMs);
      const updatedAt = new Date(nowMs - daysAgo * dayMs);

      // Power Law Assayer Workload: 20% of assayers get 80% of jobs
      let assayerId: string;
      if (rand() < 0.8) {
        const topCount = Math.max(1, Math.floor(assayerIds.length * 0.2));
        assayerId = assayerIds[Math.floor(rand() * topCount)];
      } else {
        assayerId = assayerIds[Math.floor(rand() * assayerIds.length)];
      }

      const pId = projectIds[Math.floor(rand() * projectIds.length)];
      const pbId = projectBranchIds[Math.floor(rand() * projectBranchIds.length)];

      assignmentRows.push({
        id: asgId,
        created_at: createdAt,
        updated_at: updatedAt,
        version: 1,
        is_active: isActive,
        assignment_number: asgNumber,
        project_id: pId,
        project_branch_id: pbId,
        assayer_id: assayerId,
        status,
        priority: rand() < 0.2 ? 'HIGH' : 'MEDIUM',
        scheduled_date: scheduledDate,
        completion_date: completionDate,
        sla_status: slaStatus,
        sync_token: BENCHMARK_TAG,
      });

      // Billing & Payables for COMPLETED assignments
      if (status === 'COMPLETED') {
        const rBill = rand();
        const hasEntry = rBill < 0.93; // 93% have billing entry
        const hasPayable = rBill < 0.90 || (rBill >= 0.93 && rBill < 0.95); // 92% have payable (5% unbooked backlog, 5% partial)

        if (hasEntry) {
          billingRows.push({
            id: uuidv4(),
            created_at: updatedAt,
            updated_at: updatedAt,
            version: 1,
            is_active: true,
            entry_number: `BE-${idx.toString().padStart(7, '0')}`,
            client_id: clientIds[idx % clientIds.length],
            assignment_id: asgId,
            state: 'UNBILLED',
            base_amount: 500,
            travel_amount: 150,
            adjustment_amount: 0,
            tax_rate: 18,
            taxable_amount: 650,
            tax_amount: 117,
            tds_rate: 10,
            tds_amount: 65,
            total_amount: 767,
            currency: 'INR',
            paid_amount: 0,
            outstanding_amount: 767,
            on_hold: false,
          });
        }

        if (hasPayable) {
          payableRows.push({
            id: uuidv4(),
            created_at: updatedAt,
            updated_at: updatedAt,
            version: 1,
            is_active: true,
            payable_number: `AP-${idx.toString().padStart(7, '0')}`,
            assayer_id: assayerId,
            assignment_id: asgId,
            status: 'APPROVED',
            base_amount: 400,
            travel_amount: 100,
            tax_amount: 0,
            tds_amount: 50,
            total_amount: 450,
            currency: 'INR',
            paid_amount: 0,
            on_hold: false,
            pre_invoicing_era: false,
          });
        }
      }
    }

    // Insert Assignments Batch
    const asgValues = assignmentRows.map((r, i) => `(
      $${i * 13 + 1}, $${i * 13 + 2}, $${i * 13 + 3}, $${i * 13 + 4}, $${i * 13 + 5},
      $${i * 13 + 6}, $${i * 13 + 7}, $${i * 13 + 8}, $${i * 13 + 9}, $${i * 13 + 10}::assignments_status_enum,
      $${i * 13 + 11}::assignments_priority_enum, $${i * 13 + 12}, $${i * 13 + 13}
    )`).join(', ');

    const asgParams = assignmentRows.flatMap(r => [
      r.id, r.created_at, r.updated_at, r.version, r.is_active,
      r.assignment_number, r.project_id, r.project_branch_id, r.assayer_id, r.status,
      r.priority, r.scheduled_date, r.sync_token,
    ]);

    await ds.query(`
      INSERT INTO assignments (
        id, created_at, updated_at, version, is_active,
        assignment_number, project_id, project_branch_id, assayer_id, status,
        priority, scheduled_date, sync_token
      ) VALUES ${asgValues}
    `, asgParams);

    // Update completion_date and sla_status where relevant
    const completedIds = assignmentRows.filter(r => r.completion_date).map(r => r.id);
    if (completedIds.length > 0) {
      await ds.query(`
        UPDATE assignments 
        SET completion_date = scheduled_date, sla_status = 'COMPLIANT'
        WHERE id = ANY($1)
      `, [completedIds]);
    }

    // Insert Billing Entries Batch
    if (billingRows.length > 0) {
      const beValues = billingRows.map((r, i) => `(
        $${i * 14 + 1}, $${i * 14 + 2}, $${i * 14 + 3}, $${i * 14 + 4}, $${i * 14 + 5},
        $${i * 14 + 6}, $${i * 14 + 7}, $${i * 14 + 8}, $${i * 14 + 9}, $${i * 14 + 10},
        $${i * 14 + 11}, $${i * 14 + 12}, $${i * 14 + 13}, $${i * 14 + 14}
      )`).join(', ');

      const beParams = billingRows.flatMap(r => [
        r.id, r.created_at, r.updated_at, r.version, r.is_active,
        r.entry_number, r.client_id, r.assignment_id, r.state, r.base_amount,
        r.travel_amount, r.adjustment_amount, r.taxable_amount, r.total_amount,
      ]);

      await ds.query(`
        INSERT INTO billing_entries (
          id, created_at, updated_at, version, is_active,
          entry_number, client_id, assignment_id, state, base_amount,
          travel_amount, adjustment_amount, taxable_amount, total_amount
        ) VALUES ${beValues}
      `, beParams);
    }

    // Insert Assayer Payables Batch
    if (payableRows.length > 0) {
      const apValues = payableRows.map((r, i) => `(
        $${i * 11 + 1}, $${i * 11 + 2}, $${i * 11 + 3}, $${i * 11 + 4}, $${i * 11 + 5},
        $${i * 11 + 6}, $${i * 11 + 7}, $${i * 11 + 8}, $${i * 11 + 9}, $${i * 11 + 10},
        $${i * 11 + 11}
      )`).join(', ');

      const apParams = payableRows.flatMap(r => [
        r.id, r.created_at, r.updated_at, r.version, r.is_active,
        r.payable_number, r.assayer_id, r.assignment_id, r.status, r.base_amount,
        r.total_amount,
      ]);

      await ds.query(`
        INSERT INTO assayer_payables (
          id, created_at, updated_at, version, is_active,
          payable_number, assayer_id, assignment_id, status, base_amount,
          total_amount
        ) VALUES ${apValues}
      `, apParams);
    }

    insertedAssignments += assignmentRows.length;
    insertedBillingEntries += billingRows.length;
    insertedPayables += payableRows.length;
  }

  // Update statistics for PostgreSQL query planner
  await ds.query(`ANALYZE assignments, billing_entries, assayer_payables, project_branches, branches, projects`);

  return {
    projectCount: projectIds.length,
    branchCount: branchIds.length,
    assignmentCount: insertedAssignments,
    billingEntryCount: insertedBillingEntries,
    assayerPayableCount: insertedPayables,
  };
}

export async function explainQuery(ds: DataSource, query: string, params: any[] = []): Promise<BenchmarkMetrics> {
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`;
  const res = await ds.query(explainSql, params);
  const planObj = res[0]['QUERY PLAN'][0];

  const plan = planObj.Plan;
  const planningTimeMs = planObj['Planning Time'] ?? 0;
  const executionTimeMs = planObj['Execution Time'] ?? 0;

  const stats = { hit: 0, read: 0, tempRead: 0, tempWritten: 0 };
  function collectStats(node: any) {
    if (!node) return;
    stats.hit += (node['Shared Hit Blocks'] ?? 0);
    stats.read += (node['Shared Read Blocks'] ?? 0);
    stats.tempRead += (node['Temp Read Blocks'] ?? 0);
    stats.tempWritten += (node['Temp Written Blocks'] ?? 0);
    if (Array.isArray(node.Plans)) {
      for (const child of node.Plans) {
        collectStats(child);
      }
    }
  }
  collectStats(plan);

  const rowsEstimated = plan['Plan Rows'] ?? 0;
  const rowsActual = plan['Actual Rows'] ?? 0;
  const scanType = plan['Node Type'] ?? 'Unknown';

  return {
    queryName: query.slice(0, 40).replace(/\s+/g, ' '),
    planningTimeMs,
    executionTimeMs,
    sharedHitBlocks: stats.hit,
    sharedReadBlocks: stats.read,
    tempReadBlocks: stats.tempRead,
    tempWrittenBlocks: stats.tempWritten,
    rowsEstimated,
    rowsActual,
    scanType,
    planTree: plan,
  };
}
