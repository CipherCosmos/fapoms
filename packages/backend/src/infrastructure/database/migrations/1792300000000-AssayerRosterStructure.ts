import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give the appraiser roster somewhere proper to live.
 *
 * The roster is a spreadsheet kept by hand for years — 1,155 appraisers, 71 columns — and it is
 * becoming the workforce master. Most of its columns already have a home. These are the ones
 * that do not, and each is a repeating group or a pair-fact that a column cannot hold.
 *
 *   references            two name/contact pairs written sideways as four columns. Two is not a
 *                         rule anybody chose; it is how many fitted.
 *   client empanelments   `ICICI Status` is a column per client, with AU Small and RBL surviving
 *                         only in free text. Every new client would mean new columns, and the
 *                         answer for one says nothing about another — the same person is active
 *                         for one bank and rejected by the next on the same row.
 *   background checks     four columns holding one moment, so the latest check overwrites the
 *                         last. These are the grounds on which somebody enters a bank vault;
 *                         "cleared in 2022, civil case in 2026" is a fact the column version
 *                         cannot express.
 *   onboarding documents  the same yes/no question asked fifteen times across fifteen columns.
 *                         As rows they can be counted, dated and added to.
 *   import issues         the cells nothing could be made of, kept with their original text
 *                         until a person decides. The alternative is losing a real appraiser
 *                         over one bad cell, or guessing.
 *
 * The columns added to `assayers` are the plain 1:1 facts the table simply lacked — Aadhaar,
 * bank name, date of birth, qualification — plus the three that come out of splitting the
 * roster's "Active / Inactive" column into the separate things it was holding.
 *
 * Everything is additive and idempotent. `down()` drops what this created and nothing else.
 */
export class AssayerRosterStructure1792300000000 implements MigrationInterface {
  name = 'AssayerRosterStructure1792300000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── Facts the assayer row simply did not have ──────────────────────────
    await q.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "aadhaar_number" text,
        ADD COLUMN IF NOT EXISTS "bank_name" character varying(150),
        ADD COLUMN IF NOT EXISTS "date_of_birth" date,
        ADD COLUMN IF NOT EXISTS "qualification" character varying(150),
        ADD COLUMN IF NOT EXISTS "vsts_code" character varying(60),
        ADD COLUMN IF NOT EXISTS "hr_owner_name" character varying(120),
        ADD COLUMN IF NOT EXISTS "engagement_type" character varying(30),
        ADD COLUMN IF NOT EXISTS "unavailable_reason" character varying(40),
        ADD COLUMN IF NOT EXISTS "work_done_by_someone_else" boolean NOT NULL DEFAULT false
    `);

    // The compliance flag is a small minority of rows and the only reason to query it is to
    // find them, so the index covers just those.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayers_work_by_someone_else"
        ON "assayers" ("id") WHERE "work_done_by_someone_else" = true
    `);

    // ── References ────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_references" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "full_name" character varying(200) NOT NULL,
        "phone" character varying(20),
        "relationship" character varying(100),
        "checked_at" TIMESTAMP WITH TIME ZONE,
        "checked_by" uuid,
        "remarks" text,
        CONSTRAINT "PK_assayer_references" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_references_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_references_assayer" ON "assayer_references" ("assayer_id")`);

    // ── Client empanelment ────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_client_empanelments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "client_id" uuid NOT NULL,
        "status" character varying(30) NOT NULL DEFAULT 'RECOMMENDED',
        "status_reason" text,
        "documents_outstanding" text,
        "client_reference_code" character varying(60),
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "remarks" text,
        CONSTRAINT "PK_assayer_client_empanelments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_empanelment_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_assayer_empanelment_client" FOREIGN KEY ("client_id")
          REFERENCES "clients"("id") ON DELETE CASCADE,
        -- One standing per pair. Two rows would be two answers to "may we send them", with
        -- nothing to say which counts.
        CONSTRAINT "UQ_assayer_client_empanelment" UNIQUE ("assayer_id", "client_id")
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_empanelment_client" ON "assayer_client_empanelments" ("client_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_empanelment_status" ON "assayer_client_empanelments" ("status")`);

    // ── Background and credit checks ──────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_background_checks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "verdict" character varying(30) NOT NULL DEFAULT 'NOT_CHECKED',
        "risk_grade" character varying(20),
        "cibil_score" integer,
        "cibil_band" character varying(30),
        "checked_on" date,
        "checked_by_name" character varying(200),
        "findings" text,
        CONSTRAINT "PK_assayer_background_checks" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_background_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_background_assayer" ON "assayer_background_checks" ("assayer_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_background_verdict" ON "assayer_background_checks" ("verdict")`);

    // ── Onboarding paperwork ──────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_onboarding_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "requirement" character varying(40) NOT NULL,
        "soft_copy_received" boolean,
        "hard_copy_received" boolean,
        "hard_copy_location" character varying(120),
        "courier_reference" character varying(200),
        "received_at" date,
        "remarks" text,
        CONSTRAINT "PK_assayer_onboarding_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_onboarding_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_assayer_onboarding_document" UNIQUE ("assayer_id", "requirement")
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_onboarding_requirement" ON "assayer_onboarding_documents" ("requirement")`);

    // ── What could not be read ────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_import_issues" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1, "is_active" boolean NOT NULL DEFAULT true,
        -- Nullable: a row whose assayer code was unusable has no assayer to hang off, and that
        -- is the case most worth surfacing.
        "assayer_id" uuid,
        "source_assayer_code" character varying(60),
        "source_sheet" character varying(60) NOT NULL,
        "source_row" integer NOT NULL,
        "source_column" character varying(120) NOT NULL,
        "raw_value" text NOT NULL,
        "reason" text NOT NULL,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by" uuid,
        "resolution" text,
        CONSTRAINT "PK_assayer_import_issues" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assayer_import_issue_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);
    // The review queue only ever asks for what is still open, oldest first.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assayer_import_issues_open"
        ON "assayer_import_issues" ("created_at") WHERE "resolved_at" IS NULL
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_assayer_import_issues_assayer" ON "assayer_import_issues" ("assayer_id")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "assayer_import_issues"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_onboarding_documents"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_background_checks"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_client_empanelments"`);
    await q.query(`DROP TABLE IF EXISTS "assayer_references"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_assayers_work_by_someone_else"`);
    await q.query(`
      ALTER TABLE "assayers"
        DROP COLUMN IF EXISTS "aadhaar_number",
        DROP COLUMN IF EXISTS "bank_name",
        DROP COLUMN IF EXISTS "date_of_birth",
        DROP COLUMN IF EXISTS "qualification",
        DROP COLUMN IF EXISTS "vsts_code",
        DROP COLUMN IF EXISTS "hr_owner_name",
        DROP COLUMN IF EXISTS "engagement_type",
        DROP COLUMN IF EXISTS "unavailable_reason",
        DROP COLUMN IF EXISTS "work_done_by_someone_else"
    `);
  }
}
