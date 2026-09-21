import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * High-performance indexes and revision columns for the Sumeru Global Billing Engine:
 * 1. Revision and settlement audit columns on `assayer_invoices` (Scenario F & Payout atomicity).
 * 2. `idx_assayer_invoices_recent` on `assayer_invoices (created_at DESC, id DESC)`.
 * 3. Partial index `idx_assayer_payables_eligible_invite` on `assayer_payables (assayer_id)` for `ASSAYER_INVOICE_ELIGIBLE_SQL`.
 * 4. Compound index `idx_assayer_payables_invoice_status` on `assayer_payables (assayer_invoice_id, status)`.
 */
export class BillingEngineIndexesAndRevisions1799200000000 implements MigrationInterface {
  name = 'BillingEngineIndexesAndRevisions1799200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assayer_invoices" 
        ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "supersedes_invoice_id" uuid,
        ADD COLUMN IF NOT EXISTS "superseded_by_invoice_id" uuid,
        ADD COLUMN IF NOT EXISTS "confirmed_version" integer,
        ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "paid_by" uuid;

      CREATE INDEX IF NOT EXISTS "idx_assayer_invoices_recent" 
        ON "assayer_invoices" ("created_at" DESC, "id" DESC);

      CREATE INDEX IF NOT EXISTS "idx_assayer_payables_eligible_invite" 
        ON "assayer_payables" ("assayer_id") 
        WHERE status IN ('PENDING', 'APPROVED') AND on_hold = false AND assayer_invoice_id IS NULL AND pre_invoicing_era = false;

      CREATE INDEX IF NOT EXISTS "idx_assayer_payables_invoice_status" 
        ON "assayer_payables" ("assayer_invoice_id", "status");
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DROP INDEX IF EXISTS "idx_assayer_payables_invoice_status";
      DROP INDEX IF EXISTS "idx_assayer_payables_eligible_invite";
      DROP INDEX IF EXISTS "idx_assayer_invoices_recent";

      ALTER TABLE "assayer_invoices" 
        DROP COLUMN IF EXISTS "paid_by",
        DROP COLUMN IF EXISTS "paid_at",
        DROP COLUMN IF EXISTS "confirmed_version",
        DROP COLUMN IF EXISTS "superseded_by_invoice_id",
        DROP COLUMN IF EXISTS "supersedes_invoice_id",
        DROP COLUMN IF EXISTS "revision";
    `);
  }
}
