import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One receivable and one fee payable per assignment — enforced by the database.
 *
 * ## The hole
 *
 * Auto-billing runs from the `assignment:status-changed` event: `syncAssignment` and
 * `syncPayableForAssignment` each do "find one for this assignment → none → insert". They run
 * under a Redis lock that FAILS OPEN after three seconds or whenever Redis is unavailable, and
 * event delivery is at-least-once by design (outbox + relay). CHECKED_IN, IN_PROGRESS and
 * COMPLETED fire for the same assignment seconds apart. Two syncs interleaving between the find
 * and the insert produce two billing entries and two payables for one job: a double invoice
 * line to the client and a double payout to the assayer. Neither table had a unique constraint
 * to stop it — `billing_entries.assignment_id` and `assayer_payables.assignment_id` were plain
 * btree indexes.
 *
 * ## The predicates
 *
 * - `billing_entries`: unique on `assignment_id` for ROOT rows only (`parent_entry_id IS NULL`).
 *   Split children legitimately carry their parent's assignment id and there are several of
 *   them; the invariant is one root line per assignment, which is exactly what `syncAssignment`
 *   assumes when it says "already billed".
 * - `assayer_payables`: unique on `assignment_id` for FEE payables only. Expense reimbursements
 *   are also payables against the assignment (several are normal — one per approved claim) and
 *   are recognisable by `rate_snapshot->>'source' = 'EXPENSE_CLAIM'`, the marker
 *   `ExpenseService.raiseReimbursement` writes. Everything else on an assignment is the fee.
 *
 * ## Existing data
 *
 * The migration refuses to run if either invariant is already violated, naming how many
 * assignments are affected, so a duplicate that already slipped through is surfaced and
 * reconciled by a human rather than hidden by a constraint that could not be created.
 */
export class BillingUniquenessPerAssignment1790500000000 implements MigrationInterface {
  name = 'BillingUniquenessPerAssignment1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        dup_entries integer;
        dup_payables integer;
      BEGIN
        SELECT count(*) INTO dup_entries FROM (
          SELECT assignment_id FROM billing_entries
           WHERE assignment_id IS NOT NULL AND parent_entry_id IS NULL
           GROUP BY assignment_id HAVING count(*) > 1
        ) d;
        SELECT count(*) INTO dup_payables FROM (
          SELECT assignment_id FROM assayer_payables
           WHERE assignment_id IS NOT NULL
             AND (rate_snapshot->>'source') IS DISTINCT FROM 'EXPENSE_CLAIM'
           GROUP BY assignment_id HAVING count(*) > 1
        ) d;
        IF dup_entries > 0 OR dup_payables > 0 THEN
          RAISE EXCEPTION
            'Refusing to enforce billing uniqueness: % assignment(s) already have more than one root billing entry and % have more than one fee payable. These are double-billings; reconcile them (cancel the duplicates) and re-run. See migration 1790500000000.',
            dup_entries, dup_payables;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_entries_root_per_assignment"
      ON "billing_entries" ("assignment_id")
      WHERE "assignment_id" IS NOT NULL AND "parent_entry_id" IS NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_assayer_payables_fee_per_assignment"
      ON "assayer_payables" ("assignment_id")
      WHERE "assignment_id" IS NOT NULL
        AND ("rate_snapshot"->>'source') IS DISTINCT FROM 'EXPENSE_CLAIM'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_assayer_payables_fee_per_assignment"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_entries_root_per_assignment"`);
  }
}
