/**
 * One-off runner: applies ONLY ReconcileAssignmentStatusDrift1785700000000.
 *
 * The database has no `migrations` table (it was built with synchronize:true), so a plain
 * `typeorm migration:run` would replay all 21 migrations starting with InitialMigration —
 * which creates already-existing tables and declares an obsolete assignment status enum.
 * This runs just the approved repair.
 *
 * Deliberately uses a bare DataSource: no entities registered and synchronize:false, so
 * initializing it cannot trigger a schema sync. The migration's up() only issues raw SQL.
 */
import { DataSource } from 'typeorm';
import { ReconcileAssignmentStatusDrift1785700000000 } from '../src/infrastructure/database/migrations/1785700000000-ReconcileAssignmentStatusDrift';

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
  SELECT a.assignment_number AS asn, a.status AS assignment, a.is_active,
         pb.status AS branch, s.status AS schedule
  FROM assignments a
  LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
  LEFT JOIN schedules s ON s.assignment_id = a.id AND s.is_active = true
  ORDER BY a.created_at
`;

async function main() {
  await ds.initialize();
  const qr = ds.createQueryRunner();
  await qr.connect();

  console.log('\n=== BEFORE ===');
  console.table(await qr.query(SNAPSHOT));

  await qr.startTransaction();
  try {
    await new ReconcileAssignmentStatusDrift1785700000000().up(qr);
    await qr.commitTransaction();
    console.log('\nMigration committed.');
  } catch (err) {
    await qr.rollbackTransaction();
    console.error('\nMigration FAILED — rolled back, no changes applied:', err);
    process.exitCode = 1;
  }

  console.log('\n=== AFTER ===');
  console.table(await qr.query(SNAPSHOT));

  await qr.release();
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
