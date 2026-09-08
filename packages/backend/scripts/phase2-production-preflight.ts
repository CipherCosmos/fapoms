import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.docker') });

/**
 * Phase 2 Production Migration Preflight Script
 *
 * READ-ONLY verification of database invariants before applying Phase 2 constraints and indexes.
 * Checks for zero conflicting rows on populated tables.
 *
 * Preflight Gates:
 * 1. Branch Single Active Assignment Invariant (idx_assignments_single_active_branch)
 * 2. Assayer Calendar Day Double Booking Invariant (idx_assignments_single_active_assayer_day)
 * 3. Employment Date Sanity (chk_assayers_employment_dates_sane / chk_assayers_termination_dates_sane)
 * 4. Active Assayers Payout KYC Gap Analysis
 * 5. Departed/Inactive Assayers with Active Assignments
 */
async function runPreflight() {
  const host = process.env.DB_HOST === 'postgres' ? 'localhost' : (process.env.DB_HOST || 'localhost');
  const ds = new DataSource({
    type: 'postgres',
    host,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    username: process.env.DB_USERNAME || 'fapoms',
    password: process.env.DB_PASSWORD || 'fapoms_dev',
    database: process.env.DB_DATABASE || 'fapoms',
  });

  await ds.initialize();
  console.log('===============================================================');
  console.log('PHASE 2 PRODUCTION PREFLIGHT: READ-ONLY CONSTRAINT VERIFICATION');
  console.log('===============================================================');
  console.log(`Connected to Postgres database: ${process.env.DB_DATABASE || 'fapoms'} on ${host}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  let blockingConflicts = 0;

  // 1. Check Multiple Active Assignments per Branch
  console.log('--- 1. PREFLIGHT: Multiple Active Assignments per Branch ---');
  const branchConflicts = await ds.query(`
    SELECT project_branch_id, count(*)::int as active_count,
           array_agg(id) as assignment_ids, array_agg(status) as statuses
    FROM assignments
    WHERE is_active = true
      AND project_branch_id IS NOT NULL
      AND status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
    GROUP BY project_branch_id
    HAVING count(*) > 1
  `);
  if (branchConflicts.length > 0) {
    console.error(`[FAIL] Found ${branchConflicts.length} branch(es) with multiple active assignments!`);
    console.table(branchConflicts);
    blockingConflicts += branchConflicts.length;
  } else {
    console.log('[PASS] Zero conflicting active assignments per branch. Safe for idx_assignments_single_active_branch.');
  }

  // 2. Check Multiple Active Assignments per Assayer per Day
  console.log('\n--- 2. PREFLIGHT: Assayer Calendar-Day Double-Booking ---');
  const assayerDayConflicts = await ds.query(`
    SELECT assayer_id, scheduled_date, count(*)::int as active_count,
           array_agg(id) as assignment_ids, array_agg(status) as statuses
    FROM assignments
    WHERE is_active = true
      AND scheduled_date IS NOT NULL
      AND status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
    GROUP BY assayer_id, scheduled_date
    HAVING count(*) > 1
  `);
  if (assayerDayConflicts.length > 0) {
    console.error(`[FAIL] Found ${assayerDayConflicts.length} assayer/day conflict(s)!`);
    console.table(assayerDayConflicts);
    blockingConflicts += assayerDayConflicts.length;
  } else {
    console.log('[PASS] Zero conflicting active assignments per assayer/day. Safe for idx_assignments_single_active_assayer_day.');
  }

  // 3. Check Employment Date Anomalies
  console.log('\n--- 3. PREFLIGHT: Employment Dates Sanity (Exit/Term < Joining) ---');
  const dateAnomalies = await ds.query(`
    SELECT id, assayer_code, joining_date, exit_date, termination_date
    FROM assayers
    WHERE (exit_date IS NOT NULL AND joining_date IS NOT NULL AND exit_date < joining_date)
       OR (termination_date IS NOT NULL AND joining_date IS NOT NULL AND termination_date < joining_date)
  `);
  if (dateAnomalies.length > 0) {
    console.log(`[INFO] Found ${dateAnomalies.length} legacy assayer row(s) with exit/term < joining date.`);
    console.log('       These are protected via NOT VALID constraints and will not block migration.');
  } else {
    console.log('[PASS] Zero employment date anomalies found.');
  }

  // 4. Check Active Assayers KYC Completeness
  console.log('\n--- 4. PREFLIGHT: Active Assayers Missing Payout KYC ---');
  const unpayableAssayers = await ds.query(`
    SELECT count(*)::int as total_active,
           count(*) filter (where pan_number is null or pan_number = '')::int as missing_pan,
           count(*) filter (where bank_account_number is null or bank_account_number = '')::int as missing_bank,
           count(*) filter (where ifsc_code is null or ifsc_code = '')::int as missing_ifsc,
           count(*) filter (where (pan_number is null or pan_number = '')
                               or (bank_account_number is null or bank_account_number = '')
                               or (ifsc_code is null or ifsc_code = ''))::int as missing_any_payout
    FROM assayers
    WHERE status = 'ACTIVE' AND lifecycle_status = 'ACTIVE'
  `);
  console.table(unpayableAssayers);

  // 5. Active assignments on inactive/departed assayers
  console.log('\n--- 5. PREFLIGHT: Active Assignments on Inactive/Departed Assayers ---');
  const inactiveAssayerAssignments = await ds.query(`
    SELECT a.id, a.assignment_number, a.status as assignment_status,
           asr.assayer_code, asr.status as assayer_status, asr.lifecycle_status
    FROM assignments a
    JOIN assayers asr ON asr.id = a.assayer_id
    WHERE a.status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
      AND (asr.status != 'ACTIVE' OR asr.is_active = false OR asr.lifecycle_status IN ('SUSPENDED', 'RESIGNED', 'TERMINATED', 'ARCHIVED', 'INACTIVE'))
  `);
  if (inactiveAssayerAssignments.length > 0) {
    console.log(`[WARN] Found ${inactiveAssayerAssignments.length} active assignment(s) assigned to inactive/departed assayers.`);
    console.table(inactiveAssayerAssignments);
  } else {
    console.log('[PASS] Zero active assignments assigned to inactive or departed assayers.');
  }

  console.log('\n===============================================================');
  if (blockingConflicts > 0) {
    console.error(`PREFLIGHT RESULT: FAILED with ${blockingConflicts} blocking conflict(s).`);
    console.error('Do NOT apply Phase 2 unique indexes until conflicting rows are resolved.');
    await ds.destroy();
    process.exit(1);
  } else {
    console.log('PREFLIGHT RESULT: PASSED (Zero blocking conflicts detected).');
    console.log('Safe to proceed with Phase 2 unique indexes and constraints.');
    await ds.destroy();
    process.exit(0);
  }
}

runPreflight().catch((err) => {
  console.error('Preflight error:', err);
  process.exit(1);
});
