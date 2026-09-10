import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One LIVE payable and one LIVE client line per assignment — not one row, ever.
 *
 * Both money tables keep their dead rows on purpose: voiding a payable and cancelling a client
 * line is how a reopened audit withdraws money booked for work that turned out to be wrong, and
 * deleting those rows would make the ledger claim the booking never happened.
 *
 * The uniqueness did not know that. It was one row per assignment regardless of status, so once
 * an assignment had ever been billed no replacement could be written for it. An audit that was
 * completed, reopened, redone and completed again therefore ended with its original payable
 * VOIDED, its original line CANCELLED, and nothing new — the assayer unpaid for work the system
 * had recorded as COMPLETED, the client unbilled for it, and every read that should have noticed
 * reporting the assignment healthy because a row existed.
 *
 * These indexes carry the same names as the ones they replace, so `isUniqueViolation(...)` in
 * `BillingEngineService` keeps matching, and the race it handles keeps behaving as it did.
 *
 * The predicates are the SQL half of `billing-liveness.ts` and must stay in step with it; that
 * file builds both from the same enum for exactly this reason.
 *
 * Safe to apply to a populated database: a partial index is strictly weaker than the total one it
 * replaces, so no existing row can conflict. Verified on a database carrying voided payables.
 */
export class LiveMoneyUniquePerAssignment1798000000000 implements MigrationInterface {
  name = 'LiveMoneyUniquePerAssignment1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_assayer_payables_fee_per_assignment"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_assayer_payables_fee_per_assignment"
        ON assayer_payables (assignment_id)
        WHERE expense_id IS NULL AND status NOT IN ('VOIDED')
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_entries_root_per_assignment"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_billing_entries_root_per_assignment"
        ON billing_entries (assignment_id)
        WHERE state NOT IN ('CANCELLED')
    `);
  }

  /**
   * Reverting restores the total indexes — but only if the data still allows it. An assignment
   * that has legitimately been redone since this migration ran will hold two fee payables, and
   * recreating a total unique index over them would fail. That failure is correct and is left to
   * surface: it means the database contains history this schema cannot express, and silently
   * deleting a row to make the index build would destroy a real financial record.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_assayer_payables_fee_per_assignment"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_assayer_payables_fee_per_assignment"
        ON assayer_payables (assignment_id) WHERE expense_id IS NULL
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_entries_root_per_assignment"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_billing_entries_root_per_assignment"
        ON billing_entries (assignment_id)
    `);
  }
}
