import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../packages/backend/.env.docker') });

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
  console.log('Connected to Postgres.');

  // 1. Total Assayers & breakdown
  const totalAssayers = await ds.query(`SELECT count(*)::int as count FROM assayers`);
  console.log('Total assayers:', totalAssayers[0].count);

  const statusBreakdown = await ds.query(`
    SELECT lifecycle_status, status, is_active, count(*)::int as count
    FROM assayers
    GROUP BY lifecycle_status, status, is_active
    ORDER BY count DESC
  `);
  console.log('\n--- STATUS BREAKDOWN ---');
  console.table(statusBreakdown);

  // 2. Impossible Lifecycle Combinations
  // e.g. ACTIVE but status != ACTIVE, ARCHIVED but is_active = true, etc.
  const impossibleLifecycle = await ds.query(`
    SELECT id, assayer_code, lifecycle_status, status, is_active
    FROM assayers
    WHERE (lifecycle_status = 'ACTIVE' AND status != 'ACTIVE')
       OR (lifecycle_status = 'ARCHIVED' AND is_active = true)
       OR (lifecycle_status IN ('RESIGNED', 'TERMINATED') AND status = 'ACTIVE')
       OR (lifecycle_status = 'SUSPENDED' AND status != 'SUSPENDED')
  `);
  console.log('\n--- IMPOSSIBLE LIFECYCLE COMBINATIONS ---', impossibleLifecycle.length);
  if (impossibleLifecycle.length > 0) console.table(impossibleLifecycle);

  // 3. Duplicate Identifiers
  // Duplicate Phones
  const dupPhones = await ds.query(`
    SELECT phone, count(*)::int as count, array_agg(assayer_code) as codes, array_agg(display_name) as names
    FROM assayers
    WHERE phone IS NOT NULL AND trim(phone) != ''
    GROUP BY phone
    HAVING count(*) > 1
  `);
  console.log('\n--- DUPLICATE PHONES ---', dupPhones.length);
  console.table(dupPhones);

  // Duplicate Emails
  const dupEmails = await ds.query(`
    SELECT lower(trim(email)) as clean_email, count(*)::int as count, array_agg(assayer_code) as codes, array_agg(display_name) as names
    FROM assayers
    WHERE email IS NOT NULL AND trim(email) != ''
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  `);
  console.log('\n--- DUPLICATE EMAILS ---', dupEmails.length);
  console.table(dupEmails);

  // Note: pan_number is encrypted with AES-256-GCM so raw SQL comparison only matches identical ciphertexts (which with random IV won't match), unless deterministic or plain. Let's see if there are plaintext PANs or enc:v1 prefixes:
  const panSample = await ds.query(`
    SELECT count(*)::int as total_pans,
           count(CASE WHEN pan_number LIKE 'enc:v1:%' THEN 1 END)::int as encrypted_pans,
           count(CASE WHEN pan_number NOT LIKE 'enc:v1:%' AND pan_number IS NOT NULL THEN 1 END)::int as plaintext_pans
    FROM assayers
  `);
  console.log('\n--- PAN ENCRYPTION STATS ---');
  console.table(panSample);

  // 4. Employment Dates Anomaly
  const dateAnomalies = await ds.query(`
    SELECT id, assayer_code, joining_date, exit_date, termination_date, lifecycle_status
    FROM assayers
    WHERE (exit_date IS NOT NULL AND joining_date IS NOT NULL AND exit_date < joining_date)
       OR (termination_date IS NOT NULL AND joining_date IS NOT NULL AND termination_date < joining_date)
  `);
  console.log('\n--- EMPLOYMENT DATE ANOMALIES (exit < joining) ---', dateAnomalies.length);
  console.table(dateAnomalies);

  // Departed with no exit/termination date
  const departedNoDate = await ds.query(`
    SELECT id, assayer_code, lifecycle_status, joining_date, exit_date, termination_date
    FROM assayers
    WHERE lifecycle_status IN ('RESIGNED', 'TERMINATED')
      AND exit_date IS NULL AND termination_date IS NULL
  `);
  console.log('\n--- DEPARTED BUT NO DATE ---', departedNoDate.length);
  console.table(departedNoDate);

  // 5. Active assignments with inactive or departed assayers
  const activeAssignmentsWithDeparted = await ds.query(`
    SELECT a.id, a.assignment_number, a.status as assignment_status,
           asr.assayer_code, asr.display_name, asr.status as assayer_status, asr.lifecycle_status
    FROM assignments a
    JOIN assayers asr ON asr.id = a.assayer_id
    WHERE a.status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS')
      AND (asr.status != 'ACTIVE' OR asr.is_active = false OR asr.lifecycle_status IN ('SUSPENDED', 'RESIGNED', 'TERMINATED', 'ARCHIVED', 'INACTIVE'))
  `);
  console.log('\n--- ACTIVE ASSIGNMENTS WITH INACTIVE/DEPARTED ASSAYERS ---', activeAssignmentsWithDeparted.length);
  console.table(activeAssignmentsWithDeparted);

  // 6. Suspended assayers and their assignments
  const suspendedAssayers = await ds.query(`
    SELECT asr.id, asr.assayer_code, asr.display_name, asr.lifecycle_status,
           count(a.id)::int as total_assignments,
           count(CASE WHEN a.status IN ('PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS') THEN 1 END)::int as open_assignments
    FROM assayers asr
    LEFT JOIN assignments a ON a.assayer_id = asr.id
    WHERE asr.lifecycle_status = 'SUSPENDED'
    GROUP BY asr.id, asr.assayer_code, asr.display_name, asr.lifecycle_status
  `);
  console.log('\n--- SUSPENDED ASSAYERS ---', suspendedAssayers.length);
  console.table(suspendedAssayers);

  // 7. Onboarding & KYC documents stats
  const docStats = await ds.query(`
    SELECT requirement,
           count(*)::int as total_rows,
           count(CASE WHEN soft_copy_received = true THEN 1 END)::int as soft_copy_claimed,
           count(CASE WHEN jsonb_array_length(file_paths) > 0 THEN 1 END)::int as has_file,
           count(CASE WHEN verification_status = 'VERIFIED' THEN 1 END)::int as verified_count,
           count(CASE WHEN verification_status = 'REJECTED' THEN 1 END)::int as rejected_count,
           count(CASE WHEN verification_status = 'PENDING' THEN 1 END)::int as pending_count
    FROM assayer_documents
    GROUP BY requirement
    ORDER BY total_rows DESC
  `);
  console.log('\n--- ASSAYER DOCUMENTS STATS ---');
  console.table(docStats);

  // 8. Assayers who are ACTIVE in lifecycle without verified identity documents
  const activeWithoutKyc = await ds.query(`
    SELECT asr.id, asr.assayer_code, asr.display_name, asr.lifecycle_status,
           count(d.id) FILTER (WHERE d.verification_status = 'VERIFIED') as verified_doc_count,
           count(d.id) FILTER (WHERE jsonb_array_length(d.file_paths) > 0) as doc_with_file_count
    FROM assayers asr
    LEFT JOIN assayer_documents d ON d.assayer_id = asr.id
    WHERE asr.lifecycle_status = 'ACTIVE'
    GROUP BY asr.id, asr.assayer_code, asr.display_name, asr.lifecycle_status
    HAVING count(d.id) FILTER (WHERE d.verification_status = 'VERIFIED') = 0
  `);
  console.log('\n--- ACTIVE ASSAYERS WITH 0 VERIFIED DOCUMENTS ---', activeWithoutKyc.length);

  // 9. Client Empanelments
  const empanelmentStats = await ds.query(`
    SELECT status, count(*)::int as count
    FROM assayer_client_empanelments
    GROUP BY status
    ORDER BY count DESC
  `);
  console.log('\n--- EMPANELMENT STATS ---');
  console.table(empanelmentStats);

  // Departed but still empanelled as ACTIVE or RECOMMENDED
  const departedStillEmpanelled = await ds.query(`
    SELECT asr.assayer_code, asr.lifecycle_status, e.status as empanelment_status, count(*)::int as count
    FROM assayer_client_empanelments e
    JOIN assayers asr ON asr.id = e.assayer_id
    WHERE asr.lifecycle_status IN ('RESIGNED', 'TERMINATED', 'ARCHIVED')
      AND e.status IN ('ACTIVE', 'RECOMMENDED')
    GROUP BY asr.assayer_code, asr.lifecycle_status, e.status
  `);
  console.log('\n--- DEPARTED ASSAYERS STILL EMPANELLED ---', departedStillEmpanelled.length);
  console.table(departedStillEmpanelled);

  // 10. Financial: Assayer Payables and Missing Bank Info
  const payablesMissingBank = await ds.query(`
    SELECT p.id, p.payable_number, p.status, p.total_amount,
           asr.assayer_code, asr.bank_account_number IS NULL as missing_bank,
           asr.ifsc_code IS NULL as missing_ifsc,
           asr.pan_number IS NULL as missing_pan
    FROM assayer_payables p
    JOIN assayers asr ON asr.id = p.assayer_id
    WHERE (asr.bank_account_number IS NULL OR asr.ifsc_code IS NULL OR asr.pan_number IS NULL)
      AND p.status IN ('PENDING', 'APPROVED')
  `);
  console.log('\n--- PAYABLES WITH MISSING BANK/PAN ---', payablesMissingBank.length);
  console.table(payablesMissingBank);

  // 11. Data integrity issues table overview
  const issueCounts = await ds.query(`
    SELECT (resolved_at IS NOT NULL) as is_resolved, count(*)::int as count
    FROM assayer_import_issues
    GROUP BY (resolved_at IS NOT NULL)
  `);
  console.log('\n--- IMPORT ISSUES SUMMARY ---');
  console.table(issueCounts);

  const topIssueTypes = await ds.query(`
    SELECT split_part(source_column, ' · ', 1) as issue_title, count(*)::int as count
    FROM assayer_import_issues
    WHERE resolved_at IS NULL
    GROUP BY split_part(source_column, ' · ', 1)
    ORDER BY count DESC
    LIMIT 15
  `);
  console.log('\n--- TOP OPEN INTEGRITY ISSUES ---');
  console.table(topIssueTypes);

  // 12. Password Hash & Lockout State
  const authStats = await ds.query(`
    SELECT 
      count(CASE WHEN password_hash IS NOT NULL THEN 1 END)::int as has_password,
      count(CASE WHEN password_hash IS NULL THEN 1 END)::int as no_password,
      count(CASE WHEN must_change_password = true THEN 1 END)::int as must_change_password,
      count(CASE WHEN failed_login_attempts > 0 THEN 1 END)::int as failed_attempts,
      count(CASE WHEN locked_until IS NOT NULL AND locked_until > NOW() THEN 1 END)::int as locked_accounts,
      count(CASE WHEN temp_password_expires_at IS NOT NULL THEN 1 END)::int as has_temp_password_expiry,
      count(CASE WHEN temp_password_expires_at IS NOT NULL AND temp_password_expires_at < NOW() THEN 1 END)::int as expired_temp_passwords
    FROM assayers
  `);
  console.log('\n--- AUTH & CREDENTIAL STATS ---');
  console.table(authStats);

  // 13. Workforce Attributes (Skills / Certs) Expiries
  const attrStats = await ds.query(`
    SELECT type,
           count(*)::int as total,
           count(CASE WHEN expiry_date IS NOT NULL THEN 1 END)::int as with_expiry,
           count(CASE WHEN expiry_date IS NOT NULL AND expiry_date < NOW() THEN 1 END)::int as expired
    FROM workforce_attributes
    WHERE is_active = true
    GROUP BY type
  `);
  console.log('\n--- WORKFORCE ATTRIBUTES STATS ---');
  console.table(attrStats);

  await ds.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
