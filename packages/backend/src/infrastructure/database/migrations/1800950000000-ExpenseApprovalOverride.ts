import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A SENIOR'S WRITTEN REASON FOR APPROVING A REFUSED EXPENSE CLAIM (owner decision 2026-09-24).
 *
 * Approving a claim is now refused when its assignment was cancelled, when the claim's assayer no
 * longer holds the assignment, or when the job's pay is on an assayer bill that has been sent. A
 * senior may approve anyway by writing a reason; the reason, and which refusals it set aside, are
 * kept on the claim (and in the audit trail). Nullable and additive: every existing claim was
 * approved on the normal path and keeps null.
 */
export class ExpenseApprovalOverride1800950000000 implements MigrationInterface {
  name = 'ExpenseApprovalOverride1800950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_expenses" ADD COLUMN IF NOT EXISTS "approval_override_reason" text`);
    await queryRunner.query(`ALTER TABLE "assignment_expenses" ADD COLUMN IF NOT EXISTS "approval_override_codes" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "assignment_expenses" DROP COLUMN IF EXISTS "approval_override_codes"`);
    await queryRunner.query(`ALTER TABLE "assignment_expenses" DROP COLUMN IF EXISTS "approval_override_reason"`);
  }
}
