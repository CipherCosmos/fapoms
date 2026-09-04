import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Idempotency keys for the two mobile write paths most exposed to flaky field connectivity:
 * raising an expense claim, and countering a fee offer.
 *
 * Both actions retry on a dropped response with the exact same body. Without a key to recognise
 * the retry by, each attempt landed as a distinct claim or a distinct negotiation round — a
 * receipt claimed twice, or a travel figure the assayer typed once compounding into a bigger
 * "counter" than they ever sent. The service layer checks these columns before writing; the
 * partial unique index on the claim table is the backstop for two retries that race each other
 * past that check.
 */
export class ClientRequestIdempotency1794400000000 implements MigrationInterface {
  name = 'ClientRequestIdempotency1794400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignment_expenses"
        ADD COLUMN IF NOT EXISTS "client_request_id" uuid NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_expense_assayer_client_request"
        ON "assignment_expenses" ("assayer_id", "client_request_id")
        WHERE "client_request_id" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "assignments"
        ADD COLUMN IF NOT EXISTS "last_counter_request_id" uuid NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assignments" DROP COLUMN IF EXISTS "last_counter_request_id"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_expense_assayer_client_request"
    `);
    await queryRunner.query(`
      ALTER TABLE "assignment_expenses" DROP COLUMN IF EXISTS "client_request_id"
    `);
  }
}
