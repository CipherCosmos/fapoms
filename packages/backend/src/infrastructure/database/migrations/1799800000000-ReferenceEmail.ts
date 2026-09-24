import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * EMAIL ON A REFERENCE.
 *
 * A referee is rung, and now also writable: hiring asks candidates for a referee email where
 * there is one, and the desk records it when a call produces one. Nullable and optional —
 * every reference on file today has none, and a missing email never blocks anything the way a
 * missing number does.
 */
export class ReferenceEmail1799800000000 implements MigrationInterface {
  name = 'ReferenceEmail1799800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assayer_references"
        ADD COLUMN IF NOT EXISTS "email" varchar(255)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assayer_references" DROP COLUMN IF EXISTS "email"`);
  }
}
