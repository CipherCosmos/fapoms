import { MigrationInterface, QueryRunner } from 'typeorm';
import { ReconcileRolePermissions1792000000000 } from './1792000000000-ReconcileRolePermissions';

/**
 * THE HOD'S FINAL BILLING APPROVAL (owner, 2026-09-24).
 *
 * After the office approves, a person holding the new BILLING:FINAL_APPROVE:ORGANIZATION (Admin by
 * default; grantable to any custom role — an "HOD" built in Users & Roles) approves once more
 * before money can move: assayer bills, payouts approved without a bill, expense reimbursements,
 * and client invoices before they are marked sent.
 *
 * Schema:
 *  - `assayer_payables`, `assayer_invoices`: who gave the final approval and when, and the last
 *    rejection (by, when, why). The payable is where the payment gate reads it — every way money
 *    leaves (recording a disbursement, the bank file) goes through a payable.
 *  - `billing_invoices`: the same, plus who sent the draft up for final approval; and the status
 *    CHECK widened to the two new states AWAITING_HOD and HOD_APPROVED.
 *  - `assayer_invoices.status` is an unchecked varchar; HOD_APPROVED needs no constraint change.
 *
 * DATA AT DEPLOY — deliberately NO backfill of `hod_approved_*`:
 *  - An APPROVED-but-unpaid payable (partly paid included) and an APPROVED assayer bill are waiting
 *    for the HOD from the moment this runs, exactly like one approved a minute later. Nothing here
 *    marks them approved: a gate that grandfathers what was already in front of it is not a gate.
 *  - PAID payables and bills, and ISSUED/PAID/CANCELLED client invoices, are untouched — their
 *    money already moved (or was already sent to the client), so there is nothing left to gate.
 *  - DRAFT client invoices stay DRAFT; the office sends them for final approval like any new one.
 *
 * The permission row and Admin's (and Developer's) grant come from the one grant table,
 * `ROLE_PERMISSIONS`, via the reconcile — the same way FinalApproval1800400000000 added its own.
 */
export class BillingFinalApproval1801200000000 implements MigrationInterface {
  name = 'BillingFinalApproval1801200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['assayer_payables', 'assayer_invoices', 'billing_invoices']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "hod_approved_at" timestamptz`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "hod_approved_by" uuid`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "hod_rejected_at" timestamptz`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "hod_rejected_by" uuid`);
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "hod_reject_reason" text`);
    }
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "hod_requested_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "hod_requested_by" uuid`);

    // The client invoice's two new states. Restated whole, like SimplifyBilling1791500000000 wrote it.
    await queryRunner.query(`ALTER TABLE "billing_invoices" DROP CONSTRAINT IF EXISTS "CK_billing_invoices_status"`);
    await queryRunner.query(`
      ALTER TABLE "billing_invoices"
        ADD CONSTRAINT "CK_billing_invoices_status"
        CHECK (status IN ('DRAFT','AWAITING_HOD','HOD_APPROVED','ISSUED','PAID','CANCELLED'))
    `);

    /*
      A final approval only means something on a payable the office approved: one stamped on a
      PENDING (Due) payable would read as "cleared for payment" on money nobody at the office has
      looked at. The HOD's rejection clears the stamp as it returns the payable to PENDING, so this
      holds on every write the service makes; the database says so too.
    */
    await queryRunner.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "chk_assayer_payables_hod_after_office"`);
    await queryRunner.query(`
      ALTER TABLE "assayer_payables"
        ADD CONSTRAINT "chk_assayer_payables_hod_after_office"
        CHECK (hod_approved_at IS NULL OR status IN ('APPROVED','PAID','VOIDED'))
    `);

    // The HOD's queue: approved by the office, not yet by the HOD, still owed.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_assayer_payables_awaiting_hod"
        ON "assayer_payables" ("approved_at") WHERE "status" = 'APPROVED' AND "hod_approved_at" IS NULL
    `);

    // The permission, and Admin's grant of it — whatever ROLE_PERMISSIONS says at deploy time.
    await new ReconcileRolePermissions1792000000000().up(queryRunner);
    // The reconcile names a new permission row "<action> <resource> (<scope>)"; say what it is.
    await queryRunner.query(
      `UPDATE permissions SET description = 'Final billing approval (HOD)'
        WHERE resource = 'BILLING' AND action = 'FINAL_APPROVE' AND scope = 'ORGANIZATION'
          AND (description IS NULL OR description = 'FINAL_APPROVE BILLING (ORGANIZATION)')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Anything in the two new states goes back to where the office left it: a draft.
    await queryRunner.query(`UPDATE "billing_invoices" SET status = 'DRAFT' WHERE status IN ('AWAITING_HOD','HOD_APPROVED')`);
    await queryRunner.query(`UPDATE "assayer_invoices" SET status = 'APPROVED' WHERE status = 'HOD_APPROVED'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" DROP CONSTRAINT IF EXISTS "CK_billing_invoices_status"`);
    await queryRunner.query(`
      ALTER TABLE "billing_invoices"
        ADD CONSTRAINT "CK_billing_invoices_status"
        CHECK (status IN ('DRAFT','ISSUED','PAID','CANCELLED'))
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_assayer_payables_awaiting_hod"`);
    await queryRunner.query(`ALTER TABLE "assayer_payables" DROP CONSTRAINT IF EXISTS "chk_assayer_payables_hod_after_office"`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" DROP COLUMN IF EXISTS "hod_requested_by"`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" DROP COLUMN IF EXISTS "hod_requested_at"`);
    for (const table of ['assayer_payables', 'assayer_invoices', 'billing_invoices']) {
      for (const col of ['hod_reject_reason', 'hod_rejected_by', 'hod_rejected_at', 'hod_approved_by', 'hod_approved_at']) {
        await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${col}"`);
      }
    }
    // The permission row and its grants stay (the reconcile is additive by design); unused.
  }
}
