import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The Appraiser Recruitment application layer: `assayer_interviews` (HR's pre-registration gate),
 * `assayer_applications` (a candidate's self-registration submission, with its invite token), and
 * `assayer_application_documents` (scans a candidate uploads before they are a real assayer).
 *
 * All three are new tables, deliberately separate from `assayers` and `assayer_documents` — see
 * `AssayerApplicationEntity`'s class comment for why. Column shapes mirror `BaseEntity`
 * (id/created_by/created_at/updated_by/updated_at/version/is_active) the same way every other
 * entity in this module does, so the usual repository/audit conventions apply unchanged.
 */
export class AppraiserRecruitmentApplicationLayer1798400000000 implements MigrationInterface {
  name = 'AppraiserRecruitmentApplicationLayer1798400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_interviews" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" varchar,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" int NOT NULL DEFAULT 1,
        "is_active" boolean NOT NULL DEFAULT true,
        "organization_id" uuid,
        "candidate_name" varchar(200) NOT NULL,
        "mobile" varchar(20) NOT NULL,
        "email" varchar(255),
        "notes" text,
        "outcome" varchar(10) NOT NULL,
        "interviewed_by_user_id" uuid,
        "interviewed_by_name" varchar(200),
        "interviewed_at" timestamptz NOT NULL,
        "spawned_application_id" uuid
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_interviews_organization_id"
        ON "assayer_interviews" ("organization_id")
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_applications" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" varchar,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" int NOT NULL DEFAULT 1,
        "is_active" boolean NOT NULL DEFAULT true,
        "organization_id" uuid,
        "interview_id" uuid,
        "full_name" varchar(200),
        "mobile" varchar(20) NOT NULL,
        "email" varchar(255),
        "date_of_birth" date,
        "gender" varchar(30),
        "address" text,
        "state" varchar(100),
        "city" varchar(100),
        "pincode" varchar(20),
        "experience_years" int,
        "current_employer" varchar(200),
        "expertise" varchar(300),
        "availability" varchar(200),
        "employment_category" varchar(20),
        "consent_accepted_at" timestamptz,
        "consent_version" varchar(20),
        "status" varchar(20) NOT NULL DEFAULT 'DRAFT',
        "reviewed_by" uuid,
        "reviewed_at" timestamptz,
        "review_notes" text,
        "promoted_assayer_id" uuid,
        "token_hash" varchar(128),
        "token_expires_at" timestamptz,
        "token_consumed_at" timestamptz
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_applications_organization_id"
        ON "assayer_applications" ("organization_id")
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_applications_status"
        ON "assayer_applications" ("status")
    `);
    // Every lookup from the public registration link is by token — this is the hot path.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_assayer_applications_token_hash"
        ON "assayer_applications" ("token_hash")
        WHERE "token_hash" IS NOT NULL
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_application_documents" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" varchar,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" int NOT NULL DEFAULT 1,
        "is_active" boolean NOT NULL DEFAULT true,
        "application_id" uuid NOT NULL REFERENCES "assayer_applications"("id") ON DELETE CASCADE,
        "requirement" varchar(40) NOT NULL,
        "file_paths" jsonb NOT NULL DEFAULT '[]'::jsonb,
        CONSTRAINT "UQ_application_document_requirement" UNIQUE ("application_id", "requirement")
      )
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_application_documents_application_id"
        ON "assayer_application_documents" ("application_id")
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "assayer_application_documents"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_applications_token_hash"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_applications_status"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_applications_organization_id"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_applications"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayer_interviews_organization_id"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_interviews"`);
  }
}
