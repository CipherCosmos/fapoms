import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Trigram indexes for search — restored.
 *
 * These were written as a migration that never ran: the chain they belonged to had been broken
 * for a long time, so the indexes have never existed on any database, including the one in daily
 * use. Search has been doing sequential ILIKE scans over branches, assayers, projects, clients
 * and assignments the whole time and simply getting slower as the book grew.
 *
 * Not required for correctness — ILIKE returns the same rows either way — which is exactly why
 * nobody noticed. Carried forward here rather than left behind in `_historical/` because the work
 * was right and only its delivery failed.
 *
 * `pg_trgm` itself is enabled by `EnableRequiredExtensions` before the baseline; an index cannot
 * be created before its operator class exists.
 */
export class RestoreSearchTrigramIndexes1790000000000 implements MigrationInterface {
  name = 'RestoreSearchTrigramIndexes1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
