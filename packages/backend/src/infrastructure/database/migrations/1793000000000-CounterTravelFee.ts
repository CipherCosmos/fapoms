import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What an assayer counter-offers on is the travel, not the whole fee.
 *
 * The audit fee is what the work is worth, and it comes from the rate card — the assayer does
 * not set it and neither does the desk. What varies is the journey: how far, by what, and at
 * whose cost. So that is what a counter-offer is about, and it is what the queue is now called.
 *
 * Before this, the counter moved the *total*, and `assignmentMoney` carved travel back out at
 * the frozen quoted figure — meaning every rupee an assayer negotiated landed in the base fee,
 * silently changing the price of the work rather than the price of getting there.
 *
 * `quoted_travel_fee` stays frozen: it is what the calculator said at offer time, and the
 * comparison between quoted and agreed is the whole audit value of a negotiation. This column
 * holds what was agreed instead.
 *
 * Nullable, and null means "nothing was countered" — offers that were accepted as quoted, and
 * every offer made before this existed, are read exactly as they were.
 */
export class CounterTravelFee1793000000000 implements MigrationInterface {
  name = 'CounterTravelFee1793000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "counter_travel_fee" numeric(12,2)
    `);
    // The negotiation queue asks for exactly this: offers where a travel figure is under
    // discussion. A partial index keeps it off the 99% that have none.
    await q.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assignments_counter_travel_fee"
        ON "assignments" ("counter_travel_fee") WHERE "counter_travel_fee" IS NOT NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_assignments_counter_travel_fee"`);
    await q.query(`ALTER TABLE "assignments" DROP COLUMN IF EXISTS "counter_travel_fee"`);
  }
}
