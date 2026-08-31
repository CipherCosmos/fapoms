import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One commercial profile in force per assayer per day — enforced by the database.
 *
 * Nothing closed the previous rate card when a new one was created, so an assayer could carry
 * two open-ended profiles at once. Which one "won" was then whatever each reader's ORDER BY
 * happened to return, and the four readers disagreed (see pricing/profile-in-force.ts): the fee
 * on the planning card, the fee the billing engine booked, and the amount the payout paid could
 * be three different numbers for the same audit, with nothing on any screen saying which row
 * had been used.
 *
 * `AssayerService.createCommercialProfile` now closes the row it supersedes. This migration
 * does the same for rows already stored, and then adds the constraint that makes the overlap
 * impossible rather than merely unlikely.
 *
 * Repair rule: where periods overlap, the later start wins and the earlier row is closed the
 * day before it — the same rule the service applies, so history reads consistently either way.
 * `btree_gist` is what lets a uuid equality and a range overlap sit in one EXCLUDE.
 */
export class CommercialProfileInForce1793400000000 implements MigrationInterface {
  name = 'CommercialProfileInForce1793400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    // Close every active row that overlaps a later-starting active row for the same assayer.
    // Repeated until nothing changes: closing one overlap can leave another pair adjacent.
    for (let pass = 0; pass < 10; pass++) {
      const result = await q.query(`
        UPDATE assayer_commercial_profiles older
           SET effective_end_date = GREATEST(older.effective_start_date, newer.effective_start_date - INTERVAL '1 day'),
               updated_at = NOW()
          FROM assayer_commercial_profiles newer
         WHERE older.is_active = true AND newer.is_active = true
           AND older.assayer_id = newer.assayer_id
           AND older.id <> newer.id
           AND newer.effective_start_date > older.effective_start_date
           AND (older.effective_end_date IS NULL OR older.effective_end_date >= newer.effective_start_date)
         RETURNING older.id
      `);
      const changed = Array.isArray(result) ? result.length : 0;
      if (changed === 0) break;
    }

    // Two rows sharing the same start date are a genuine ambiguity no rule can resolve — the
    // newest-created one is kept and the rest deactivated, which is what a human would do.
    await q.query(`
      UPDATE assayer_commercial_profiles p
         SET is_active = false, updated_at = NOW()
       WHERE p.is_active = true
         AND EXISTS (
           SELECT 1 FROM assayer_commercial_profiles q
            WHERE q.is_active = true AND q.assayer_id = p.assayer_id
              AND q.effective_start_date = p.effective_start_date
              AND (q.created_at, q.id) > (p.created_at, p.id)
         )
    `);

    await q.query(`
      ALTER TABLE assayer_commercial_profiles
        ADD CONSTRAINT "EXCL_commercial_profile_period"
        EXCLUDE USING gist (
          assayer_id WITH =,
          tstzrange(effective_start_date, COALESCE(effective_end_date, 'infinity'::timestamptz), '[]') WITH &&
        ) WHERE (is_active)
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE assayer_commercial_profiles DROP CONSTRAINT IF EXISTS "EXCL_commercial_profile_period"`);
    // The closed end-dates are left as they are: they are now the truth about which rate applied
    // when, and reopening them would restore the ambiguity this migration removed.
  }
}
