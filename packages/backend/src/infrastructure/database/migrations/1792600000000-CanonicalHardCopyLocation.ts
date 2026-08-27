import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One name per office, in the column that says where a signed original is kept.
 *
 * It was free text. One place was typed five ways — "Sent to Bangalore office", "Sent to
 * Bangalore Office", "Bangalore office", "Bangalore Office", "sent to Bangalore office" — across
 * 112 rows, so "which originals are in Bangalore?" had no answer a query could give. Vasai had
 * two spellings.
 *
 * Two values were not places at all. "Recieved" and "Recived" were saying the original had
 * arrived, in the column meant for where it went, so they become what they meant:
 * `hard_copy_received = true` and no location. "Rejected by Sumeru" is neither a place nor an
 * arrival; it is moved to remarks rather than deleted, because somebody wrote it deliberately
 * and it is the only record of whatever it refers to.
 *
 * The UI is a picker from here on — see HARD_COPY_LOCATIONS — so this is a one-off tidy of what
 * the free-text years produced, not a rule that needs applying again.
 */
export class CanonicalHardCopyLocation1792600000000 implements MigrationInterface {
  name = 'CanonicalHardCopyLocation1792600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "assayer_documents"
         SET "hard_copy_location" = 'Bangalore office'
       WHERE "hard_copy_location" ILIKE '%bangalore%'
    `);
    await q.query(`
      UPDATE "assayer_documents"
         SET "hard_copy_location" = 'Vasai office'
       WHERE "hard_copy_location" ILIKE '%vasai%'
    `);

    // Said the original arrived, in the wrong column. Recorded as the arrival it was.
    await q.query(`
      UPDATE "assayer_documents"
         SET "hard_copy_received" = true, "hard_copy_location" = NULL
       WHERE "hard_copy_location" ILIKE 'rec%ved'
    `);

    // Neither a place nor an arrival. Kept, where a person will see it.
    await q.query(`
      UPDATE "assayer_documents"
         SET "remarks" = COALESCE("remarks" || ' — ', '') || "hard_copy_location",
             "hard_copy_location" = NULL
       WHERE "hard_copy_location" IS NOT NULL
         AND "hard_copy_location" NOT IN ('Bangalore office', 'Vasai office')
    `);
  }

  /**
   * Not reversible, and deliberately so: the original spellings are exactly the information this
   * removed, and restoring "Sent to Bangalore Office" on some arbitrary subset of the rows would
   * invent a distribution that never existed. Down is a no-op rather than a lie.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see above.
  }
}
