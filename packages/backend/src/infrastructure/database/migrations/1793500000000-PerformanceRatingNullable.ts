import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "No rating yet" stops meaning "a perfect rating".
 *
 * `performance_rating` was NOT NULL DEFAULT 5.00, and no importer ever wrote it — so all 1,155
 * imported appraisers sat at exactly 5.00, the top of the scale. The recommendation engine
 * reads it as measured fact three times, and two of those award a bonus to anyone at or above
 * 4.5 on a HIGH-RISK branch. The effect was the opposite of the intent: the people nobody had
 * assessed were preferentially routed to the most sensitive vaults.
 *
 * The qualification score already refuses this column for exactly this reason ("the columns'
 * flattering defaults … would hand a perfect track record to someone who has never been offered
 * work"), which left the two halves of the system disagreeing about the same person — "no work
 * history yet" on the profile a partner bank sees, "high reliability" in the engine that hands
 * out the work.
 *
 * Every stored value is a default nobody chose, so they all become NULL: unrated, honestly.
 * The engine now scores NULL neutrally and never awards the seniority bonus on it. A real
 * rating typed by HR still works exactly as before.
 */
export class PerformanceRatingNullable1793500000000 implements MigrationInterface {
  name = 'PerformanceRatingNullable1793500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE assayers ALTER COLUMN performance_rating DROP DEFAULT`);
    await q.query(`ALTER TABLE assayers ALTER COLUMN performance_rating DROP NOT NULL`);
    // Only the untouched defaults are cleared. Anything a human actually set to something other
    // than 5.00 is a real assessment and is left alone.
    await q.query(`UPDATE assayers SET performance_rating = NULL WHERE performance_rating = 5.00`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE assayers SET performance_rating = 5.00 WHERE performance_rating IS NULL`);
    await q.query(`ALTER TABLE assayers ALTER COLUMN performance_rating SET NOT NULL`);
    await q.query(`ALTER TABLE assayers ALTER COLUMN performance_rating SET DEFAULT 5.00`);
  }
}
