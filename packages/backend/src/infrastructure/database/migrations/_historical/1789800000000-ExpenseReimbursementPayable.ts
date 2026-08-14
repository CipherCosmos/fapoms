import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Approved expense claims become payables.
 *
 * An assayer could submit a claim and ops could approve it, and then nothing happened — there
 * was no paid state on the claim and no row anywhere that owed them the money. The claim sat at
 * APPROVED forever while the assayer waited for a reimbursement the system had no way to make.
 *
 * Rather than grow a second payout mechanism beside `assayer_payables` (which already has
 * approval, disbursement, TDS and a payment history), approval now raises a payable and the
 * claim points at it. `reimbursement_payable_id` is the link, and it is what makes the claim's
 * paid state derivable rather than a fourth status that could disagree with the payable.
 */
export class ExpenseReimbursementPayable1789800000000 implements MigrationInterface {
  name = 'ExpenseReimbursementPayable1789800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assignment_expenses
        ADD COLUMN IF NOT EXISTS reimbursement_payable_id uuid NULL
    `);

    // No FK cascade: deleting a payable must never silently delete the claim that justified it.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_assignment_expenses_reimbursement_payable'
        ) THEN
          ALTER TABLE assignment_expenses
            ADD CONSTRAINT fk_assignment_expenses_reimbursement_payable
            FOREIGN KEY (reimbursement_payable_id) REFERENCES assayer_payables(id)
            ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // One payable per claim — the guard against approving twice and paying twice. Partial, so
    // the many claims still awaiting approval (all NULL) do not collide with each other.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_assignment_expenses_reimbursement_payable
        ON assignment_expenses (reimbursement_payable_id)
        WHERE reimbursement_payable_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_assignment_expenses_status_assayer
        ON assignment_expenses (status, assayer_id)
        WHERE is_active = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_assignment_expenses_status_assayer`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_assignment_expenses_reimbursement_payable`);
    await queryRunner.query(`
      ALTER TABLE assignment_expenses DROP CONSTRAINT IF EXISTS fk_assignment_expenses_reimbursement_payable
    `);
    await queryRunner.query(`ALTER TABLE assignment_expenses DROP COLUMN IF EXISTS reimbursement_payable_id`);
  }
}
