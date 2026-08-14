import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Postgres extensions this schema cannot be created without. Runs before everything.
 *
 * Nothing in the codebase created these. The development database has them because somebody typed
 * `CREATE EXTENSION` by hand once, years of work ago, and every database since has been a copy or
 * a `synchronize` rebuild of that one. So a genuinely new machine — the whole point of a
 * migration chain — would fail on the very first table.
 *
 * It is not a subtle failure either. The baseline schema calls `uuid_generate_v4()` as a column
 * default 72 times and declares three `geometry` columns; without these extensions the first
 * `CREATE TABLE` aborts and nothing else runs.
 *
 * Timestamped ahead of the baseline so it is always first.
 *
 *   uuid-ossp  — `uuid_generate_v4()`, the primary-key default on every table
 *   postgis    — `geometry(Point,4326)` on branches and assayers, and the ST_* distance
 *                queries the planning and coverage engines are built on
 *   pg_trgm    — trigram indexes for search. Not required for correctness: search uses ILIKE,
 *                which works without it. Included because the indexes that use it are restored
 *                by the migration after the baseline, and an index cannot be created before its
 *                operator class exists.
 *
 * `IF NOT EXISTS` throughout, so this is a no-op on every database that already has them.
 *
 * NOTE ON PRIVILEGES: creating an extension requires a superuser or a role with CREATE on the
 * database. The `postgis/postgis` image runs migrations as the owner, which has it. On a managed
 * Postgres (RDS, Cloud SQL) where the application role may not, an operator must run these three
 * statements once before the first deploy — they are listed above precisely so that is a
 * two-minute task and not an outage.
 */
export class EnableRequiredExtensions1783000000000 implements MigrationInterface {
  name = 'EnableRequiredExtensions1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  }

  public async down(): Promise<void> {
    // Deliberately not dropped. Extensions are database-wide and other schemas may depend on
    // them; removing PostGIS to roll back one migration would take every geometry column in the
    // database with it. Rolling back the schema does not mean un-installing Postgres features.
  }
}
