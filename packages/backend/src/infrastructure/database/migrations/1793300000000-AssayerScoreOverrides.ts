import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Manual overrides for the assayer qualification scores.
 *
 * The scores themselves are computed on read from the vetting tables and are deliberately not
 * stored — caching them would need an invalidation hook at every write path, the exact drift
 * failure `assayers.status` already demonstrated once. What IS stored is the one thing the
 * data cannot produce: a human's stated correction, with its reason, author and time.
 *
 * The partial unique index allows exactly one LIVE override per (assayer, dimension, partner
 * slot) while keeping every superseded row as history: clearing an override flips `is_active`
 * off rather than deleting, so "who adjusted this number, when, and why" always has an answer
 * — these rows justify figures on paper handed to partner banks.
 *
 * COALESCE folds the NULL client (the profile-level slot) into a fixed sentinel uuid, because
 * Postgres unique indexes treat NULLs as distinct and would otherwise allow two live
 * profile-level overrides of the same dimension.
 */
export class AssayerScoreOverrides1793300000000 implements MigrationInterface {
  name = 'AssayerScoreOverrides1793300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS "assayer_score_overrides" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" character varying, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1, "is_active" boolean NOT NULL DEFAULT true,
        "assayer_id" uuid NOT NULL,
        "client_id" uuid,
        "dimension" character varying(40) NOT NULL,
        "value" integer NOT NULL,
        "reason" text NOT NULL,
        "set_by" uuid,
        "set_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_assayer_score_overrides" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_score_override_value" CHECK ("value" >= 0 AND "value" <= 100),
        CONSTRAINT "FK_score_override_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_score_override_client" FOREIGN KEY ("client_id")
          REFERENCES "clients"("id") ON DELETE CASCADE
      )
    `);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_score_overrides_assayer" ON "assayer_score_overrides" ("assayer_id")`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_score_overrides_assayer_client" ON "assayer_score_overrides" ("assayer_id", "client_id")`);
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_score_overrides_live_slot"
        ON "assayer_score_overrides" ("assayer_id", "dimension", COALESCE("client_id", '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE "is_active" = true
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "assayer_score_overrides"`);
  }
}
