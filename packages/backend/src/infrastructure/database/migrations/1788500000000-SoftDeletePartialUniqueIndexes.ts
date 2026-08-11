import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces hard UNIQUE constraints on client_code, project_number, and assayer_code
 * with partial unique indexes (WHERE is_active = true). This prevents soft-deleted rows
 * (is_active = false) from blocking the creation or reuse of codes for active records.
 */
export class SoftDeletePartialUniqueIndexes1788500000000 implements MigrationInterface {
  name = 'SoftDeletePartialUniqueIndexes1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Clients client_code
    await queryRunner.query(`ALTER TABLE "clients" DROP CONSTRAINT IF EXISTS "UQ_7874e3c6cbb791a3bc75c9dcd71"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_clients_client_code_active" ON "clients" ("client_code") WHERE "is_active" = true`,
    );

    // 2. Projects project_number
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "UQ_a77b19582f25838ea68bbd4ffdf"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_projects_project_number_active" ON "projects" ("project_number") WHERE "is_active" = true`,
    );

    // 3. Assayers assayer_code
    await queryRunner.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "UQ_ac38fe8dfe44eb1ad3310e29fb0"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_assayers_assayer_code_active" ON "assayers" ("assayer_code") WHERE "is_active" = true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assayers_assayer_code_active"`);
    await queryRunner.query(
      `ALTER TABLE "assayers" ADD CONSTRAINT "UQ_ac38fe8dfe44eb1ad3310e29fb0" UNIQUE ("assayer_code")`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_project_number_active"`);
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "UQ_a77b19582f25838ea68bbd4ffdf" UNIQUE ("project_number")`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_clients_client_code_active"`);
    await queryRunner.query(
      `ALTER TABLE "clients" ADD CONSTRAINT "UQ_7874e3c6cbb791a3bc75c9dcd71" UNIQUE ("client_code")`,
    );
  }
}
