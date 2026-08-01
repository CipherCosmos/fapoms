import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Models the client's day-before intake as what it actually is: one batch per
 * audit date, covering every branch scheduled that day.
 *
 * The `customer_master_versions` module already reconciled a multi-branch client
 * file correctly, but was unreachable — both its endpoints required a
 * `CUSTOMER_MASTER` permission that is not a member of PermissionResource and had
 * zero rows, so no role could satisfy it. With the real path blocked, the client's
 * file was instead pushed through the per-branch document upload and tagged
 * `CUSTOMER_MASTER_DATA`, filing a single branch's row against a file covering ten.
 *
 * Two things were missing to make the correct model usable:
 *   1. the audit date the batch is for — the batch was only "version N of the
 *      project", which cannot answer "did tomorrow's data arrive?";
 *   2. a link from a generated audit packet back to the batch that produced it,
 *      so a run can report how many of its branches have had a PDF made.
 */
export class CustomerMasterDailyBatch1786400000000 implements MigrationInterface {
  name = 'CustomerMasterDailyBatch1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE customer_master_versions
        ADD COLUMN IF NOT EXISTS audit_date date
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_customer_master_versions_audit_date"
        ON customer_master_versions (project_id, audit_date)
    `);

    await queryRunner.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS customer_master_version_id uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_documents_customer_master_version"
        ON documents (customer_master_version_id)
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE documents
          ADD CONSTRAINT "FK_documents_customer_master_version"
          FOREIGN KEY (customer_master_version_id)
          REFERENCES customer_master_versions(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Retire the placeholder rows produced by the old "fabricate a PDF when a
    // branch has none" behaviour: 686-byte stubs written by the system user and
    // auto-marked DISPATCHED, so they looked like real client paperwork already
    // sent to an assayer. Deactivated rather than deleted so the audit trail that
    // references them stays intact.
    await queryRunner.query(`
      UPDATE documents
         SET is_active = false
       WHERE type = 'CUSTOMER_MASTER_DATA'
         AND file_name LIKE 'PreAudit_CustomerMaster_%'
         AND file_size < 2000
    `);

    // Any remaining CUSTOMER_MASTER_DATA row is a real file a person uploaded
    // under the wrong type because the form offered it. Reclassify to the branch
    // audit packet — which is what a per-branch PDF actually is — and reset it to
    // UPLOADED so it goes through dispatch properly instead of being silently
    // treated as already sent.
    await queryRunner.query(`
      UPDATE documents
         SET type = 'PRE_FIELD_AUDIT_PDF',
             status = CASE WHEN status = 'DISPATCHED' AND dispatched_at IS NULL THEN 'UPLOADED' ELSE status END
       WHERE type = 'CUSTOMER_MASTER_DATA'
         AND is_active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS "FK_documents_customer_master_version"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_documents_customer_master_version"`);
    await queryRunner.query(`ALTER TABLE documents DROP COLUMN IF EXISTS customer_master_version_id`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_customer_master_versions_audit_date"`);
    await queryRunner.query(`ALTER TABLE customer_master_versions DROP COLUMN IF EXISTS audit_date`);
    // The reclassified/deactivated document rows are intentionally not restored:
    // the stubs were never real files, and the reclassified ones are correctly
    // typed now.
  }
}
