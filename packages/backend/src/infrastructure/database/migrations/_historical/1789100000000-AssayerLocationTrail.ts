import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The evidence trail behind a travel allowance.
 *
 * `assayer_payables.travel_amount` is real money, and the distance behind it is computed at quote
 * time from the assayer's *registered home address* to the branch — a claimed distance, not an
 * observed one, and not persisted afterwards. The only GPS the platform kept was
 * `assayers.live_location`: a single column overwritten by every push, opt-in and default off. So
 * a journey that never happened left no contradicting record anywhere, and a journey that did
 * happen could not be evidenced either.
 *
 * This table stores positions as reported — raw, with their accuracy and both clocks — so that
 * what a set of fixes *means* stays a separate, re-runnable judgement (TravelVerificationService)
 * rather than something baked irreversibly into the data on write.
 *
 * Deliberately NOT partitioned yet: at a realistic 1 fix/30s per active assayer this grows fast,
 * but the retention design (how long movement data about identifiable workers may be kept) is a
 * policy decision, not a technical one, and partitioning without that decision just moves the
 * question. The `recorded_at` index below is the range a purge or a monthly partition would use
 * when that decision is made — see the append-only-table retention item in the upgrade review.
 */
export class AssayerLocationTrail1789100000000 implements MigrationInterface {
  name = 'AssayerLocationTrail1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "assayer_location_pings" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by"      character varying,
        "created_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by"      character varying,
        "updated_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"         integer NOT NULL DEFAULT 1,
        "is_active"       boolean NOT NULL DEFAULT true,
        "assayer_id"      uuid NOT NULL,
        "assignment_id"   uuid,
        "latitude"        numeric(10,7) NOT NULL,
        "longitude"       numeric(10,7) NOT NULL,
        "location"        geometry(Point,4326),
        "accuracy_meters" integer,
        "speed_mps"       numeric(8,2),
        "recorded_at"     TIMESTAMP WITH TIME ZONE NOT NULL,
        "received_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "source"          character varying(20) NOT NULL DEFAULT 'APP_TRACKING',
        "is_mocked"       boolean NOT NULL DEFAULT false,
        CONSTRAINT "fk_location_pings_assayer" FOREIGN KEY ("assayer_id")
          REFERENCES "assayers"("id") ON DELETE CASCADE
      )
    `);

    // Fixes explicitly tagged to a job.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_location_pings_assignment"
      ON "assayer_location_pings" ("assignment_id")
      WHERE "assignment_id" IS NOT NULL
    `);

    // Spatial index, matching how assayers.location is indexed, for "who was near here" questions.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_location_pings_location"
      ON "assayer_location_pings" USING gist ("location")
    `);

    /**
     * One fix per assayer per instant, and the ordered range scan every verification performs.
     *
     * The field app retries a failed batch, and a retry that re-sent yesterday's trail would
     * otherwise double every distance derived from it — inflating the very number this table
     * exists to check. Making the dedupe a database constraint rather than application logic means
     * it holds no matter which path writes. (This same index is declared on the entity, so that a
     * `synchronize`-driven dev database does not quietly rebuild the table without it.)
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_location_pings_assayer_instant"
      ON "assayer_location_pings" ("assayer_id", "recorded_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "assayer_location_pings"`);
  }
}
