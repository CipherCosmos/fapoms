import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let the database refuse a contact channel it does not recognise.
 *
 * `preferred_contact_channel` decides how the platform reaches an assayer, and it exists because
 * not every assayer has a smartphone: `APP` sends a notification, `PHONE` raises a call task for
 * a person to ring them, `AUTO` picks based on whether they have app access. Writing an
 * unrecognised value there does not fail — it produces a row that matches none of those branches,
 * so the assayer is simply never contacted by either route, silently, until somebody notices they
 * have stopped responding.
 *
 * Until now the only gate was `@IsIn(CONTACT_CHANNELS)` on the two request DTOs. That covers the
 * HTTP path and nothing else: an import, a script, a backfill, a repository call from a service
 * that does not go through a DTO, or a future endpoint whose author does not know the rule can
 * all put anything up to ten characters in the column. The column is `varchar(10)`, not an enum,
 * so the type gives nothing either.
 *
 * The three values are named literally rather than derived from the TypeScript list, because SQL
 * cannot import it. That is a duplicated rule and worth saying so out loud: if a fourth channel is
 * ever added, `CONTACT_CHANNELS` in `assayer.controller.ts` and this constraint have to change
 * together. `contact-channel-parity.spec.ts` fails if they drift apart, which is what makes the
 * duplication safe to live with.
 *
 * Applies cleanly with no backfill: all 1,163 rows hold 'AUTO', the column's default, because
 * nothing could set it until the field reached the DTOs earlier today.
 */
export class ContactChannelCheck1794300000000 implements MigrationInterface {
  name = 'ContactChannelCheck1794300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dropped first so a re-run after a partial failure is not blocked by its own leftovers;
    // `ADD CONSTRAINT` has no IF NOT EXISTS form.
    await queryRunner.query(`
      ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "CHK_assayer_contact_channel"
    `);
    await queryRunner.query(`
      ALTER TABLE "assayers"
        ADD CONSTRAINT "CHK_assayer_contact_channel"
        CHECK ("preferred_contact_channel" IN ('AUTO', 'APP', 'PHONE'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayers" DROP CONSTRAINT IF EXISTS "CHK_assayer_contact_channel"
    `);
  }
}
