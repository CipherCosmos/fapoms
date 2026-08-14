import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Un-mutes everyone the old column default silently muted.
 *
 * `notification_preferences.email` defaulted to FALSE, from back when nothing could send email
 * anyway. Once email started sending, that default became a trapdoor: the rest of the pipeline
 * treats *absence of an explicit false* as consent, but saving any preference at all — turning
 * push off for one category — created a row carrying `email = false`, which the delivery worker
 * reads as a deliberate opt-out and honours forever. Somebody who muted push for Assignments
 * cannot have meant "and never email me about an SLA breach again".
 *
 * Every existing false is therefore that default rather than a choice: email has never been
 * deliverable until now, so nobody has had the opportunity to opt out of it. They are flipped
 * to true, and the column default is corrected so new rows join the other two channels in
 * meaning "on unless told otherwise". A genuine opt-out made from today onward stores false and
 * is left alone by this one-time correction.
 */
export class EmailPreferenceOptedInByDefault1789500000000 implements MigrationInterface {
  name = 'EmailPreferenceOptedInByDefault1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences" ALTER COLUMN "email" SET DEFAULT true
    `);
    await queryRunner.query(`
      UPDATE "notification_preferences" SET "email" = true WHERE "email" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the default is restored. The backfilled values are deliberately left alone: they
    // are now indistinguishable from real choices, and re-muting real choices would be worse
    // than leaving a corrected default in place.
    await queryRunner.query(`
      ALTER TABLE "notification_preferences" ALTER COLUMN "email" SET DEFAULT false
    `);
  }
}
