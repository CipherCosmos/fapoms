import { MigrationInterface, QueryRunner } from 'typeorm';

export class Phase3AssayerLifecycleHardening1796400000000 implements MigrationInterface {
  name = 'Phase3AssayerLifecycleHardening1796400000000';

  public async up(q: QueryRunner): Promise<void> {
    // 1. Assayer Registration Idempotency Records (tenant-scoped)
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_idempotency_records" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "client_request_id" varchar(100) NOT NULL,
        "assayer_id" uuid NOT NULL,
        "command" varchar(50) NOT NULL,
        "organization_id" uuid NULL,
        "actor_id" uuid NULL,
        "request_hash" varchar(64) NOT NULL,
        "response_payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "FK_assayer_idempotency_assayer" FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`
      ALTER TABLE "assayer_idempotency_records"
      ADD COLUMN IF NOT EXISTS "organization_id" uuid NULL
    `);
    await q.query(`DROP INDEX IF EXISTS "uq_assayer_idempotency_key"`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_assayer_idempotency_tenant_key"
      ON "assayer_idempotency_records" (COALESCE("organization_id", '00000000-0000-0000-0000-000000000000'::uuid), "client_request_id")
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_assayer_idempotency_assayer" ON "assayer_idempotency_records" ("assayer_id")`);

    // 2. Assayer Document Versions (Historical evidence versioning)
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_document_versions" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "document_id" uuid NOT NULL,
        "assayer_id" uuid NOT NULL,
        "requirement" varchar(40) NOT NULL,
        "version" int NOT NULL,
        "file_path" text NOT NULL,
        "file_checksum" varchar(64) NULL,
        "content_sha256" varchar(64) NULL,
        "storage_object_id" text NULL,
        "file_size" bigint NULL,
        "mime_type" varchar(100) NULL,
        "uploaded_at" timestamptz NOT NULL DEFAULT now(),
        "uploaded_by" uuid NULL,
        "verification_status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "verified_at" timestamptz NULL,
        "verified_by" uuid NULL,
        "rejection_reason" varchar(40) NULL,
        "superseded_by_version_id" uuid NULL,
        "superseded_at" timestamptz NULL,
        CONSTRAINT "FK_assayer_doc_versions_document" FOREIGN KEY ("document_id") REFERENCES "assayer_documents"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_assayer_doc_versions_assayer" FOREIGN KEY ("assayer_id") REFERENCES "assayers"("id") ON DELETE CASCADE,
        CONSTRAINT "uq_assayer_doc_versions_doc_ver" UNIQUE ("document_id", "version")
      )
    `);
    await q.query(`
      ALTER TABLE "assayer_document_versions"
      ADD COLUMN IF NOT EXISTS "content_sha256" varchar(64) NULL,
      ADD COLUMN IF NOT EXISTS "storage_object_id" text NULL
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "idx_assayer_doc_versions_assayer_req" ON "assayer_document_versions" ("assayer_id", "requirement")`);

    // 3. Add current_version_id to assayer_documents if missing
    await q.query(`
      ALTER TABLE "assayer_documents"
      ADD COLUMN IF NOT EXISTS "current_version_id" uuid NULL
    `);

    // 4. Assayer Payable Payout Destination Snapshot Columns (Frozen before consumption)
    await q.query(`
      ALTER TABLE "assayer_payables"
      ADD COLUMN IF NOT EXISTS "destination_bank_account_number" text NULL,
      ADD COLUMN IF NOT EXISTS "destination_ifsc" varchar(20) NULL,
      ADD COLUMN IF NOT EXISTS "destination_bank_name" varchar(150) NULL,
      ADD COLUMN IF NOT EXISTS "destination_account_holder_name" varchar(200) NULL,
      ADD COLUMN IF NOT EXISTS "payout_evidence_version_id" uuid NULL,
      ADD COLUMN IF NOT EXISTS "destination_verified_at" timestamptz NULL
    `);

    // 5. Payment Payout Destination Snapshot Columns
    await q.query(`
      ALTER TABLE "billing_payments"
      ADD COLUMN IF NOT EXISTS "destination_bank_account_number" text NULL,
      ADD COLUMN IF NOT EXISTS "destination_ifsc" varchar(20) NULL,
      ADD COLUMN IF NOT EXISTS "destination_bank_name" varchar(150) NULL,
      ADD COLUMN IF NOT EXISTS "destination_account_holder_name" varchar(200) NULL,
      ADD COLUMN IF NOT EXISTS "payout_evidence_version_id" uuid NULL,
      ADD COLUMN IF NOT EXISTS "destination_verified_at" timestamptz NULL
    `);

    // 6. Assignment Historical Empanelment Snapshot Columns
    await q.query(`
      ALTER TABLE "assignments"
      ADD COLUMN IF NOT EXISTS "empanelment_standing_at_creation" varchar(50) NULL,
      ADD COLUMN IF NOT EXISTS "empanelment_id" uuid NULL,
      ADD COLUMN IF NOT EXISTS "empanelment_version_at_creation" integer NULL,
      ADD COLUMN IF NOT EXISTS "empanelment_effective_at" timestamptz NULL,
      ADD COLUMN IF NOT EXISTS "empanelment_verified_at" timestamptz NULL,
      ADD COLUMN IF NOT EXISTS "empanelment_override_used" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "empanelment_override_reason" text NULL,
      ADD COLUMN IF NOT EXISTS "empanelment_override_by" uuid NULL
    `);

    // 7. Database CHECK constraints on assayers protecting invariants separately:
    // Invariant 1: Operational status projection for all 11 business lifecycle statuses
    await q.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_status_lifecycle_consistency"`);
    await q.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_lifecycle_status_projection"`);
    await q.query(`
      ALTER TABLE "assayers"
      ADD CONSTRAINT "chk_assayers_lifecycle_status_projection"
      CHECK (
        (lifecycle_status::text = 'ACTIVE' AND status::text = 'ACTIVE') OR
        (lifecycle_status::text = 'SUSPENDED' AND status::text = 'SUSPENDED') OR
        (lifecycle_status::text IN ('INVITED', 'DOCUMENT_VERIFICATION', 'BACKGROUND_VERIFICATION', 'TRAINING', 'ON_LEAVE', 'INACTIVE', 'RESIGNED', 'TERMINATED', 'ARCHIVED') AND status::text = 'INACTIVE')
      );
    `);

    // Invariant 2: Independent active / soft-delete record flag protection
    await q.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_is_active_consistency"`);
    await q.query(`
      ALTER TABLE "assayers"
      ADD CONSTRAINT "chk_assayers_is_active_consistency"
      CHECK (
        (is_active = false AND status::text = 'INACTIVE' AND lifecycle_status::text NOT IN ('ACTIVE', 'SUSPENDED')) OR
        (is_active = true AND lifecycle_status::text != 'ARCHIVED')
      );
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_is_active_consistency"`);
    await q.query(`ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "chk_assayers_lifecycle_status_projection"`);
    await q.query(`
      ALTER TABLE "assignments"
      DROP COLUMN IF EXISTS "empanelment_override_by",
      DROP COLUMN IF EXISTS "empanelment_override_reason",
      DROP COLUMN IF EXISTS "empanelment_override_used",
      DROP COLUMN IF EXISTS "empanelment_verified_at",
      DROP COLUMN IF EXISTS "empanelment_effective_at",
      DROP COLUMN IF EXISTS "empanelment_version_at_creation",
      DROP COLUMN IF EXISTS "empanelment_id",
      DROP COLUMN IF EXISTS "empanelment_standing_at_creation"
    `);
    await q.query(`
      ALTER TABLE "billing_payments"
      DROP COLUMN IF EXISTS "destination_bank_account_number",
      DROP COLUMN IF EXISTS "destination_ifsc",
      DROP COLUMN IF EXISTS "destination_bank_name",
      DROP COLUMN IF EXISTS "destination_account_holder_name",
      DROP COLUMN IF EXISTS "payout_evidence_version_id",
      DROP COLUMN IF EXISTS "destination_verified_at"
    `);
    await q.query(`
      ALTER TABLE "assayer_payables"
      DROP COLUMN IF EXISTS "destination_bank_account_number",
      DROP COLUMN IF EXISTS "destination_ifsc",
      DROP COLUMN IF EXISTS "destination_bank_name",
      DROP COLUMN IF EXISTS "destination_account_holder_name",
      DROP COLUMN IF EXISTS "payout_evidence_version_id",
      DROP COLUMN IF EXISTS "destination_verified_at"
    `);
    await q.query(`ALTER TABLE "assayer_documents" DROP COLUMN IF EXISTS "current_version_id"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_document_versions"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_idempotency_records"`);
  }
}
