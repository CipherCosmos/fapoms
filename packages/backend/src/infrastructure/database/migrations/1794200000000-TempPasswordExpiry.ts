import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make the temporary password's expiry a fact rather than a sentence.
 *
 * Issuing app access hands HR a word-based temporary password and a date it is good for, which
 * HR reads out or sends on. Until now that date was computed for display only: there was no
 * column to hold it, so nothing at sign-in ever compared against it. The only credential state on
 * `assayers` was `password_hash`, `must_change_password`, `failed_login_attempts` and
 * `locked_until` — none of which expires. A credential an administrator chose, spoke aloud, and
 * possibly wrote on paper therefore worked for ever, and the API said otherwise in the same
 * breath as issuing it. Telling somebody a credential expires when it does not is worse than not
 * mentioning expiry at all, because it is what stops them chasing it.
 *
 * Nullable, and NOT backfilled. A null means "no expiry applies", which is the truth for two
 * different populations and must stay readable as both: the eight accounts that already have a
 * password, whose issue date nobody recorded and which it would be an invention to guess; and
 * every assayer who has since chosen their own password, where an expiry would be meaningless.
 * Backfilling a date would either lock real people out of an application they use, or state an
 * issue time that never happened.
 *
 * The expiry only ever bites while `must_change_password` is true — that is, while the password
 * is still the one somebody else chose. Choosing your own clears it. So this can never expire a
 * credential its owner picked.
 */
export class TempPasswordExpiry1794200000000 implements MigrationInterface {
  name = 'TempPasswordExpiry1794200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers"
        ADD COLUMN IF NOT EXISTS "temp_password_expires_at" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN "assayers"."temp_password_expires_at" IS
        'When an HR-issued temporary password stops working. Enforced at sign-in only while must_change_password is true; cleared when the assayer chooses their own password. NULL means no expiry applies.'
    `);
  }

  /**
   * Dropping the column returns the system to never expiring a temporary password, which is the
   * defect this removes — so a down migration loses a control rather than restoring a behaviour
   * anybody wants. It is provided because the runner expects it, and it destroys no data that
   * exists anywhere else: the expiry is derived from the moment access was issued, and the audit
   * event for that issue survives independently.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers" DROP COLUMN IF EXISTS "temp_password_expires_at"
    `);
  }
}
