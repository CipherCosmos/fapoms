import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One record per document, instead of three tables that each held part of the answer.
 *
 * "Have we got their PAN?" had three answers in three places:
 *
 *   assayers.pan_number             the number, as a column on the person
 *   assayer_government_documents    a verified identity document with an expiry and a file
 *   assayer_onboarding_documents    whether a copy had arrived, soft or hard
 *
 * The two vocabularies had already begun to collide — the shared label map carries both `PAN`
 * and `PAN_CARD`, both `AADHAAR` and `AADHAAR_CARD` — and HR had three screens to check before
 * answering a question that has one answer.
 *
 * The checklist wins because it is the one anybody used: 11,021 rows against nothing at all.
 * `assayer_government_documents` and the separate `assayer_documents` file store are empty in
 * every environment, so nothing is migrated out of them and `down()` restores them whole.
 *
 * What the register could say and the checklist could not — a document number, an expiry, a
 * verification, a file — is added here, and the merged table takes the plain name.
 */
export class OneDocumentRecord1792500000000 implements MigrationInterface {
  name = 'OneDocumentRecord1792500000000';

  public async up(q: QueryRunner): Promise<void> {
    // Refuse rather than destroy. These are empty everywhere this has been checked, and if that
    // is ever untrue the right response is a migration that carries the rows over, not this one
    // running anyway.
    for (const table of ['assayer_documents', 'assayer_government_documents']) {
      const [{ count }] = await q.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
      if (count > 0) {
        throw new Error(
          `${table} holds ${count} rows. This migration folds it into assayer_onboarding_documents `
          + 'on the understanding that it is empty; write the data migration before running it.',
        );
      }
    }

    await q.query(`DROP TABLE IF EXISTS "assayer_documents"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_government_documents"`);

    await q.query(`
      ALTER TABLE "assayer_onboarding_documents"
        ADD COLUMN IF NOT EXISTS "document_number" text,
        ADD COLUMN IF NOT EXISTS "expiry_date" date,
        ADD COLUMN IF NOT EXISTS "verification_status" character varying(20),
        ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "verified_by" uuid,
        ADD COLUMN IF NOT EXISTS "file_paths" jsonb NOT NULL DEFAULT '[]'::jsonb
    `);

    // Nullable, unlike the register's NOT NULL DEFAULT 'PENDING'. Only identity documents are
    // verified; a code-of-conduct letter that reads "Pending verification" for ever is an alarm
    // nobody can clear, and the 11,021 existing rows would all have started there.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_documents_verification"
        ON "assayer_onboarding_documents" ("verification_status")
        WHERE "verification_status" IS NOT NULL
    `);
    // The only question asked of expiries is which are closest to lapsing.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_documents_expiry"
        ON "assayer_onboarding_documents" ("expiry_date") WHERE "expiry_date" IS NOT NULL
    `);

    await q.query(`ALTER TABLE "assayer_onboarding_documents" RENAME TO "assayer_documents"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME CONSTRAINT "PK_assayer_onboarding_documents" TO "PK_assayer_documents"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME CONSTRAINT "FK_assayer_onboarding_assayer" TO "FK_assayer_documents_assayer"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME CONSTRAINT "UQ_assayer_onboarding_document" TO "UQ_assayer_document_requirement"`);
    await q.query(`ALTER INDEX "IDX_assayer_onboarding_requirement" RENAME TO "IDX_assayer_documents_requirement"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER INDEX IF EXISTS "IDX_assayer_documents_requirement" RENAME TO "IDX_assayer_onboarding_requirement"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME CONSTRAINT "UQ_assayer_document_requirement" TO "UQ_assayer_onboarding_document"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME CONSTRAINT "FK_assayer_documents_assayer" TO "FK_assayer_onboarding_assayer"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME CONSTRAINT "PK_assayer_documents" TO "PK_assayer_onboarding_documents"`);
    await q.query(`ALTER TABLE "assayer_documents" RENAME TO "assayer_onboarding_documents"`);

    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_documents_expiry"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_documents_verification"`);
    await q.query(`
      ALTER TABLE "assayer_onboarding_documents"
        DROP COLUMN IF EXISTS "document_number",
        DROP COLUMN IF EXISTS "expiry_date",
        DROP COLUMN IF EXISTS "verification_status",
        DROP COLUMN IF EXISTS "verified_at",
        DROP COLUMN IF EXISTS "verified_by",
        DROP COLUMN IF EXISTS "file_paths"
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_government_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "document_type" character varying(50) NOT NULL,
        "document_number" text NOT NULL,
        "expiry_date" date,
        "verification_status" character varying(20) NOT NULL DEFAULT 'PENDING',
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "verified_by" uuid,
        "file_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "remarks" text,
        CONSTRAINT "PK_assayer_government_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_government_documents_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_gov_doc_assayer" ON "assayer_government_documents" ("assayer_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_gov_doc_type" ON "assayer_government_documents" ("document_type")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_gov_doc_verification" ON "assayer_government_documents" ("verification_status")`);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_documents_files" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "document_type" character varying(50) NOT NULL,
        "file_name" character varying(255) NOT NULL,
        "file_path" text NOT NULL,
        "file_size" integer NOT NULL,
        "mime_type" character varying(100),
        "doc_version" integer NOT NULL DEFAULT 1,
        "parent_document_id" uuid,
        "remarks" text,
        CONSTRAINT "PK_assayer_documents_files" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_documents_files_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);
    // Named apart from the merged table above, which now owns "assayer_documents". Restoring the
    // original name would collide, and this table was empty when it was dropped.
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_doc_file_assayer" ON "assayer_documents_files" ("assayer_id")`);
  }
}
