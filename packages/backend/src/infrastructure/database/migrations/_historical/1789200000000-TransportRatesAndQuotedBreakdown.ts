import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The transport rate card, and the quote breakdown offers have always thrown away.
 *
 * Two related gaps closed at once:
 *
 * 1. `transport_rates` — what a kilometre costs by each mode of travel (bus, train, own
 *    two-wheeler…), scoped NATIONAL / REGION / STATE with most-specific-wins resolution. Until
 *    now the platform had exactly one travel number: a per-km rate on the client contract,
 *    applied identically everywhere and by every means of travel. The desk manages these rows
 *    (Transport Costs dashboard) and `FeePolicyService.quote()` recommends offer travel from
 *    them — before the offer goes out, which is the whole point.
 *
 * 2. `assignments.quoted_*` — the quote's distance and travel component, persisted at offer
 *    time. These were computed and immediately discarded: the travel-verification endpoint has
 *    to *recompute* the expected distance from the assayer's current home (flagged
 *    `expectedIsRecomputed`, because the home may have moved since), expense review has nothing
 *    to compare a claim against, and the assayer is shown a single opaque total. What was
 *    quoted is part of what was offered; it should have been stored all along.
 *
 * Seeded rates ship `is_active = false`. They make the dashboard immediately usable — review,
 * adjust, activate — without a deploy silently changing the money on every offer the moment it
 * lands. Activating a rate is a deliberate human act.
 */
export class TransportRatesAndQuotedBreakdown1789200000000 implements MigrationInterface {
  name = 'TransportRatesAndQuotedBreakdown1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "transport_rates" (
        "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_by"     character varying,
        "created_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by"     character varying,
        "updated_at"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "version"        integer NOT NULL DEFAULT 1,
        "is_active"      boolean NOT NULL DEFAULT true,
        "mode"           character varying(30) NOT NULL,
        "scope_type"     character varying(20) NOT NULL,
        "scope_value"    character varying(60),
        "base_fare"      numeric(10,2) NOT NULL DEFAULT 0,
        "per_km_rate"    numeric(10,4) NOT NULL,
        "is_preferred"   boolean NOT NULL DEFAULT false,
        "effective_from" date NOT NULL,
        "effective_to"   date,
        "notes"          text
      )
    `);

    // Also declared on the entity — dev runs synchronize=true, which rebuilds tables from the
    // entity class and drops any index that exists only here.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transport_rates_scope"
      ON "transport_rates" ("scope_type", "scope_value")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_transport_rates_mode"
      ON "transport_rates" ("mode")
    `);

    // The quoted breakdown, persisted at offer creation. Nullable throughout: offers created
    // before this migration simply have no recorded quote, and consumers already treat that
    // as "recompute and say so".
    await queryRunner.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "quoted_distance_km" numeric(8,2),
        ADD COLUMN IF NOT EXISTS "quoted_base_fee" numeric(12,2),
        ADD COLUMN IF NOT EXISTS "quoted_travel_fee" numeric(12,2),
        ADD COLUMN IF NOT EXISTS "quoted_transport_mode" character varying(30)
    `);

    /**
     * Starter national rates, INACTIVE, so the dashboard opens with something recognisable to
     * edit instead of an empty table and a blank form. Figures are ordinary 2026 Indian
     * ballpark costs (state bus fare slabs, IR sleeper class, city auto meters, AAR-style
     * own-vehicle running costs) — deliberately round, deliberately unofficial: the desk is
     * expected to replace them with negotiated reality before activating.
     */
    // `version` is set explicitly: on a dev database the table may have been created by
    // synchronize from the entity, where @VersionColumn carries no DB default — an insert
    // relying on the CREATE TABLE default above would fail there.
    await queryRunner.query(`
      INSERT INTO "transport_rates"
        ("mode", "scope_type", "scope_value", "base_fare", "per_km_rate", "is_preferred", "effective_from", "is_active", "version", "notes")
      VALUES
        ('BUS',           'NATIONAL', NULL, 10,  1.50, true,  CURRENT_DATE, false, 1, 'Seed default — review and activate. Ordinary state-transport fare.'),
        ('TRAIN',         'NATIONAL', NULL, 20,  1.00, false, CURRENT_DATE, false, 1, 'Seed default — review and activate. Sleeper-class ballpark.'),
        ('TWO_WHEELER',   'NATIONAL', NULL, 0,   4.00, false, CURRENT_DATE, false, 1, 'Seed default — review and activate. Own two-wheeler running cost.'),
        ('CAR',           'NATIONAL', NULL, 0,  10.00, false, CURRENT_DATE, false, 1, 'Seed default — review and activate. Own car running cost.'),
        ('AUTO_RICKSHAW', 'NATIONAL', NULL, 25, 12.00, false, CURRENT_DATE, false, 1, 'Seed default — review and activate. City auto meter ballpark.'),
        ('TAXI',          'NATIONAL', NULL, 50, 18.00, false, CURRENT_DATE, false, 1, 'Seed default — review and activate. App-cab ballpark.')
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments"
        DROP COLUMN IF EXISTS "quoted_distance_km",
        DROP COLUMN IF EXISTS "quoted_base_fee",
        DROP COLUMN IF EXISTS "quoted_travel_fee",
        DROP COLUMN IF EXISTS "quoted_transport_mode"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "transport_rates"`);
  }
}
