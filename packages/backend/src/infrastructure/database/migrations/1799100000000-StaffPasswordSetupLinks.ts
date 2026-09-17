import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LET STAFF CHOOSE THEIR OWN PASSWORD.
 *
 * Adding a colleague meant an administrator inventing a password, typing it into a form, and
 * passing it on — so every new account began life with a password a second person knew, usually
 * sent over a messaging app. These columns carry a one-time link instead: the person clicks it and
 * sets their own, and no administrator ever sees it.
 *
 * Only the token's HASH is stored, the same discipline the candidate registration invite uses.
 */
export class StaffPasswordSetupLinks1799100000000 implements MigrationInterface {
  name = 'StaffPasswordSetupLinks1799100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "password_setup_token_hash" varchar(64),
        ADD COLUMN IF NOT EXISTS "password_setup_expires_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "password_setup_sent_at" timestamptz
    `);
    // The public page looks an account up BY the hash, and by nothing else.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_password_setup_token"
        ON "users" ("password_setup_token_hash")
        WHERE "password_setup_token_hash" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_password_setup_token"`);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "password_setup_token_hash",
        DROP COLUMN IF EXISTS "password_setup_expires_at",
        DROP COLUMN IF EXISTS "password_setup_sent_at"
    `);
  }
}
