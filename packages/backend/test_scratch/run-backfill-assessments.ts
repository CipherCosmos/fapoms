/**
 * One-off runner: applies ONLY BackfillAssessmentLinks1785800000000.
 *
 * Same rationale as run-reconcile-migration.ts — the database has no `migrations` table
 * (built with synchronize:true), so `typeorm migration:run` would replay all 21 migrations
 * from InitialMigration. Bare DataSource, no entities, synchronize:false.
 */
import { DataSource } from 'typeorm';
import { BackfillAssessmentLinks1785800000000 } from './infrastructure/database/migrations/1785800000000-BackfillAssessmentLinks';

const ds = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'fapoms',
  password: process.env.DB_PASSWORD || 'fapoms_dev',
  database: process.env.DB_DATABASE || 'fapoms',
  synchronize: false,
  logging: false,
  entities: [],
  migrations: [],
});

const SNAPSHOT = `
  SELECT pb.id::text AS branch, pb.status AS branch_status,
         asn.assignment_number AS asn,
         (asn.assessment_id IS NOT NULL) AS linked,
         ass.status AS assessment_status,
         ass.audit_date, ass.coverage_flag
  FROM project_branches pb
  LEFT JOIN assignments asn ON asn.project_branch_id = pb.id
  LEFT JOIN assessments ass ON ass.project_id = pb.project_id AND ass.branch_id = pb.branch_id AND ass.is_active = true
  ORDER BY pb.created_at
`;
const COUNTS = `
  SELECT (SELECT COUNT(*) FROM assessments) AS assessments,
         (SELECT COUNT(*) FROM assignments WHERE assessment_id IS NOT NULL) AS linked_assignments,
         (SELECT COUNT(*) FROM assignments) AS total_assignments,
         (SELECT COUNT(*) FROM assessments WHERE status <> 'PENDING_PLANNING') AS advanced,
         (SELECT COUNT(*) FROM assessments WHERE audit_date IS NOT NULL) AS with_audit_date
`;

async function main() {
  await ds.initialize();
  const qr = ds.createQueryRunner();
  await qr.connect();

  console.log('\n=== BEFORE ===');
  console.table(await qr.query(COUNTS));
  console.table(await qr.query(SNAPSHOT));

  await qr.startTransaction();
  try {
    await new BackfillAssessmentLinks1785800000000().up(qr);
    await qr.commitTransaction();
    console.log('\nCommitted.');
  } catch (err) {
    await qr.rollbackTransaction();
    console.error('\nFAILED — rolled back, no changes applied:', err);
    process.exitCode = 1;
  }

  console.log('\n=== AFTER ===');
  console.table(await qr.query(COUNTS));
  console.table(await qr.query(SNAPSHOT));

  await qr.release();
  await ds.destroy();
}

main().catch((e) => { console.error(e); process.exit(1); });
