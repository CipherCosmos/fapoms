import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

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
  console.log('Connected to Postgres via TypeORM.');

  // 1. Table row counts
  const tables = [
    'assayers', 'assignments', 'project_branches', 'projects', 'clients',
    'branches', 'billing_entries', 'assayer_payables', 'documents',
    'assayer_documents', 'schedules', 'users', 'roles', 'audit_events',
    'outbox_events', 'data_integrity_issues'
  ];

  console.log('\n--- TABLE ROW COUNTS ---');
  for (const t of tables) {
    try {
      const res = await ds.query(`SELECT count(*)::int as count FROM "${t}"`);
      console.log(`${t}: ${res[0].count}`);
    } catch (e: any) {
      console.log(`${t}: ERROR: ${e.message}`);
    }
  }

  // 2. Assayer Lifecycle vs Operational Status Inconsistency
  console.log('\n--- ASSAYER LIFECYCLE VS OPERATIONAL STATUS ---');
  const assayerStatusCheck = await ds.query(`
    SELECT lifecycle_status, status, is_active, count(*)::int as count 
    FROM assayers 
    GROUP BY lifecycle_status, status, is_active 
    ORDER BY count DESC
  `);
  console.table(assayerStatusCheck);

  // 3. Active assignments with inactive or departed assayers
  console.log('\n--- ASSIGNMENT VS ASSAYER STATUS INCONSISTENCY ---');
  const activeAssignmentInactiveAssayer = await ds.query(`
    SELECT a.id, a.assignment_number, a.status as assignment_status, 
           asr.assayer_code, asr.status as assayer_status, asr.lifecycle_status, asr.is_active as assayer_is_active
    FROM assignments a
    JOIN assayers asr ON asr.id = a.assayer_id
    WHERE a.status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
      AND (asr.status != 'ACTIVE' OR asr.is_active = false OR asr.lifecycle_status IN ('SUSPENDED', 'RESIGNED', 'TERMINATED', 'ARCHIVED', 'INACTIVE'))
  `);
  console.log(`Active assignments with inactive/departed assayers: ${activeAssignmentInactiveAssayer.length}`);
  if (activeAssignmentInactiveAssayer.length > 0) {
    console.table(activeAssignmentInactiveAssayer);
  }

  // 4. Assignments pointing to inactive branches or inactive projects
  console.log('\n--- ASSIGNMENT VS BRANCH / PROJECT STATUS ---');
  const assignmentInactiveBranch = await ds.query(`
    SELECT a.id, a.assignment_number, a.status, b.name as branch_name, b.is_active as branch_is_active, p.name as project_name, p.is_active as project_is_active
    FROM assignments a
    LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
    LEFT JOIN branches b ON b.id = pb.branch_id
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
      AND (b.is_active = false OR p.is_active = false)
  `);
  console.log(`Active assignments with inactive branch/project: ${assignmentInactiveBranch.length}`);
  if (assignmentInactiveBranch.length > 0) {
    console.table(assignmentInactiveBranch);
  }

  // 5. Assignments in COMPLETED status missing completion_date or evidence
  console.log('\n--- COMPLETED ASSIGNMENTS EVIDENCE CHECK ---');
  const completedWithoutEvidence = await ds.query(`
    SELECT id, assignment_number, status, completion_date, checked_in_at, completed_without_check_in_reason
    FROM assignments
    WHERE status = 'COMPLETED'
      AND (completion_date IS NULL OR (checked_in_at IS NULL AND completed_without_check_in_reason IS NULL))
  `);
  console.log(`Completed assignments without date or attendance/reason: ${completedWithoutEvidence.length}`);
  if (completedWithoutEvidence.length > 0) {
    console.table(completedWithoutEvidence);
  }

  // 6. Check-in timestamps vs Check-out timestamps
  console.log('\n--- CHECK-IN / CHECK-OUT TIMESTAMPS ANOMALIES ---');
  const timestampAnomalies = await ds.query(`
    SELECT id, assignment_number, status, checked_in_at, checked_out_at
    FROM assignments
    WHERE checked_in_at IS NOT NULL AND checked_out_at IS NOT NULL
      AND checked_out_at < checked_in_at
  `);
  console.log(`Assignments where checked_out_at < checked_in_at: ${timestampAnomalies.length}`);
  if (timestampAnomalies.length > 0) {
    console.table(timestampAnomalies);
  }

  // 7. Check-out without check-in
  const checkoutWithoutCheckin = await ds.query(`
    SELECT id, assignment_number, status, checked_in_at, checked_out_at
    FROM assignments
    WHERE checked_in_at IS NULL AND checked_out_at IS NOT NULL
  `);
  console.log(`Assignments where checked_out_at exists without checked_in_at: ${checkoutWithoutCheckin.length}`);

  // 8. Approved / Active assayers with incomplete KYC / verification
  console.log('\n--- ASSAYER KYC / VERIFICATION ANOMALIES ---');
  const activeAssayersNoIdentity = await ds.query(`
    SELECT count(*)::int as count
    FROM assayers
    WHERE status = 'ACTIVE' AND lifecycle_status = 'ACTIVE'
      AND identity_verified_at IS NULL
  `);
  console.log(`Active assayers with identity_verified_at IS NULL: ${activeAssayersNoIdentity[0].count}`);

  const activeAssayersNoPan = await ds.query(`
    SELECT count(*)::int as count
    FROM assayers
    WHERE status = 'ACTIVE' AND lifecycle_status = 'ACTIVE'
      AND (pan_number IS NULL OR pan_number = '')
  `);
  console.log(`Active assayers with pan_number IS NULL: ${activeAssayersNoPan[0].count}`);

  const activeAssayersNoBank = await ds.query(`
    SELECT count(*)::int as count
    FROM assayers
    WHERE status = 'ACTIVE' AND lifecycle_status = 'ACTIVE'
      AND (bank_account_number IS NULL OR bank_account_number = '')
  `);
  console.log(`Active assayers with bank_account_number IS NULL: ${activeAssayersNoBank[0].count}`);

  // 9. Orphaned records
  console.log('\n--- ORPHANED RECORDS CHECK ---');
  const orphanPB = await ds.query(`
    SELECT count(*)::int as count
    FROM project_branches pb
    LEFT JOIN projects p ON p.id = pb.project_id
    LEFT JOIN branches b ON b.id = pb.branch_id
    WHERE p.id IS NULL OR b.id IS NULL
  `);
  console.log(`Orphaned project_branches: ${orphanPB[0].count}`);

  const orphanAssignments = await ds.query(`
    SELECT count(*)::int as count
    FROM assignments a
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN assayers asr ON asr.id = a.assayer_id
    WHERE p.id IS NULL OR asr.id IS NULL
  `);
  console.log(`Orphaned assignments (missing project or assayer): ${orphanAssignments[0].count}`);

  // 10. Assayer Import Issues table contents
  console.log('\n--- ASSAYER IMPORT ISSUES TABLE ---');
  try {
    const issues = await ds.query(`
      SELECT source_column, (resolved_at IS NULL) as is_unresolved, count(*)::int as count
      FROM assayer_import_issues
      GROUP BY source_column, (resolved_at IS NULL)
      ORDER BY count DESC
    `);
    console.table(issues);
  } catch (e: any) {
    console.log(`assayer_import_issues query error: ${e.message}`);
  }

  // 11. Duplicate phones across assayers
  console.log('\n--- DUPLICATE PHONES ---');
  const dupPhones = await ds.query(`
    SELECT phone, count(*)::int as count, array_agg(assayer_code) as codes
    FROM assayers
    WHERE phone IS NOT NULL AND phone != '' AND is_active = true
    GROUP BY phone
    HAVING count(*) > 1
  `);
  console.log(`Duplicate phone groups: ${dupPhones.length}`);
  if (dupPhones.length > 0) {
    console.table(dupPhones.slice(0, 10));
  }

  // 12. Duplicate emails across assayers
  console.log('\n--- DUPLICATE EMAILS ---');
  const dupEmails = await ds.query(`
    SELECT lower(trim(email)) as clean_email, count(*)::int as count, array_agg(assayer_code) as codes
    FROM assayers
    WHERE email IS NOT NULL AND email != '' AND is_active = true
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  `);
  console.log(`Duplicate email groups: ${dupEmails.length}`);
  if (dupEmails.length > 0) {
    console.table(dupEmails.slice(0, 10));
  }

  // 13. Assayer employment dates sanity
  console.log('\n--- ASSAYER EMPLOYMENT DATES ANOMALIES ---');
  const employmentDateAnomalies = await ds.query(`
    SELECT id, assayer_code, joining_date, exit_date, termination_date
    FROM assayers
    WHERE (exit_date IS NOT NULL AND joining_date IS NOT NULL AND exit_date < joining_date)
       OR (termination_date IS NOT NULL AND joining_date IS NOT NULL AND termination_date < joining_date)
  `);
  console.log(`Employment date anomalies (exit/term < joining): ${employmentDateAnomalies.length}`);
  if (employmentDateAnomalies.length > 0) {
    console.table(employmentDateAnomalies);
  }

  // 14. Departed lifecycle with no exit or termination date
  const departedWithoutDate = await ds.query(`
    SELECT count(*)::int as count
    FROM assayers
    WHERE lifecycle_status IN ('RESIGNED', 'TERMINATED', 'ARCHIVED')
      AND exit_date IS NULL AND termination_date IS NULL
  `);
  console.log(`Departed assayers without exit/termination date: ${departedWithoutDate[0].count}`);

  // 15. Assayer Documents breakdown
  console.log('\n--- ASSAYER DOCUMENTS STATUS ---');
  try {
    const docStatus = await ds.query(`
      SELECT document_type, verification_status, count(*)::int as count
      FROM assayer_documents
      GROUP BY document_type, verification_status
      ORDER BY document_type, count DESC
    `);
    console.table(docStatus);
  } catch (e: any) {
    console.log(`assayer_documents query error: ${e.message}`);
  }

  // 16. Pending outbox events / dead letters
  console.log('\n--- OUTBOX EVENTS STATUS ---');
  try {
    const outboxStatus = await ds.query(`
      SELECT 
        (dispatched_at IS NULL) as is_pending,
        count(*)::int as count,
        max(attempts) as max_attempts,
        count(*) filter (where attempts > 3)::int as high_retries
      FROM outbox_events
      GROUP BY (dispatched_at IS NULL)
    `);
    console.table(outboxStatus);
  } catch (e: any) {
    console.log(`outbox_events query error: ${e.message}`);
  }

  await ds.destroy();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
