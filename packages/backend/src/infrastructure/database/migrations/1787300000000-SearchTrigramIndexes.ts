import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trigram (GIN) indexes for global search.
 *
 * SearchService.searchAll runs leading-wildcard `ILike('%term%')` across many
 * text columns on branches, assayers, projects, clients and assignments. A plain
 * b-tree index cannot serve a leading `%`, so every query degrades to a full
 * sequential scan — fine on a seed database, ruinous at millions of rows.
 *
 * pg_trgm's GIN operator class (`gin_trgm_ops`) indexes the 3-grams of a string,
 * which lets Postgres accelerate `ILIKE '%term%'` (and `LIKE`) without rewriting a
 * single query — the existing ILike calls transparently start using these indexes
 * once the term is long enough to yield a trigram (hence the >= 2 char guard added
 * on the service side).
 *
 * Every statement is idempotent (`IF NOT EXISTS`) so the migration is safe to run
 * against a database that already has some or all of these objects. `down` drops
 * the indexes but intentionally leaves the `pg_trgm` extension in place, since other
 * objects may come to depend on it and dropping an extension is not reversible data.
 */
export class SearchTrigramIndexes1787300000000 implements MigrationInterface {
  name = 'SearchTrigramIndexes1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

    // branches — name, branch_code, city, state, address
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_branches_name" ON "branches" USING gin ("name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_branches_branch_code" ON "branches" USING gin ("branch_code" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_branches_city" ON "branches" USING gin ("city" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_branches_state" ON "branches" USING gin ("state" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_branches_address" ON "branches" USING gin ("address" gin_trgm_ops)`);

    // assayers — display_name, first_name, last_name, assayer_code, phone, email
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assayers_display_name" ON "assayers" USING gin ("display_name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assayers_first_name" ON "assayers" USING gin ("first_name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assayers_last_name" ON "assayers" USING gin ("last_name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assayers_assayer_code" ON "assayers" USING gin ("assayer_code" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assayers_phone" ON "assayers" USING gin ("phone" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assayers_email" ON "assayers" USING gin ("email" gin_trgm_ops)`);

    // projects — name, project_number
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_projects_name" ON "projects" USING gin ("name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_projects_project_number" ON "projects" USING gin ("project_number" gin_trgm_ops)`);

    // clients — name, client_code, display_name
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_clients_name" ON "clients" USING gin ("name" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_clients_client_code" ON "clients" USING gin ("client_code" gin_trgm_ops)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_clients_display_name" ON "clients" USING gin ("display_name" gin_trgm_ops)`);

    // assignments — assignment_number
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trgm_assignments_assignment_number" ON "assignments" USING gin ("assignment_number" gin_trgm_ops)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assignments_assignment_number"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_clients_display_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_clients_client_code"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_clients_name"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_projects_project_number"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_projects_name"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assayers_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assayers_phone"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assayers_assayer_code"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assayers_last_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assayers_first_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_assayers_display_name"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_branches_address"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_branches_state"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_branches_city"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_branches_branch_code"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_trgm_branches_name"`);

    // Extension left in place intentionally — other objects may depend on it.
  }
}
