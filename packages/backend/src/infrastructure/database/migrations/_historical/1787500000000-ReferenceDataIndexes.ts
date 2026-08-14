import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for hot reference-data lookups the entities left unindexed (assessment §5.4).
 *
 *  - client_configurations(client_id, effective_from): FeePolicyService resolves the latest
 *    configuration for a client on every fee quote — filter by client_id, order by
 *    effective_from. client_id is NOT unique here (configurations are versioned over time), so
 *    nothing indexed it and the lookup was a sequential scan.
 *  - clients(organization_id): the column a tenant-scoping filter (ADR-001) will key on, and
 *    any org-scoped client query; currently unindexed.
 *  - clients(lifecycle_status): roster/list filtering by status.
 *
 * Deliberately NOT added because they are already indexed: client_billing(client_id) and
 * clients(client_code) are UNIQUE columns (Postgres builds an index for the constraint), and
 * roles/capabilities/responsibilities have UNIQUE name columns and are tiny lookup tables where
 * a further index buys nothing.
 *
 * Every statement is idempotent (IF NOT EXISTS / IF EXISTS), so the migration is safe to re-run.
 */
export class ReferenceDataIndexes1787500000000 implements MigrationInterface {
  name = 'ReferenceDataIndexes1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_client_configurations_client_effective" ON "client_configurations" ("client_id", "effective_from")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_clients_organization" ON "clients" ("organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_clients_lifecycle_status" ON "clients" ("lifecycle_status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_clients_lifecycle_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_clients_organization"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_configurations_client_effective"`);
  }
}
