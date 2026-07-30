import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repairs cross-entity assignment status drift.
 *
 * The state of one real-world audit is stored in several places at once —
 * `assignments.status`, `project_branches.status` and `schedules.status`.
 * Until the accompanying code fix, `document.controller.ts` completed an
 * assignment by hand: it wrote `assignments.status = 'COMPLETED'` directly and
 * then updated the branch and schedule through separate raw-SQL statements,
 * each wrapped in a silent `.catch(() => {})`. Any one of those failing left
 * the assignment COMPLETED while its branch stayed SCHEDULED and its schedule
 * stayed RESCHEDULED — so the same audit appeared "Completed" on one screen,
 * "Scheduled" on another and "Rescheduled" on a third.
 *
 * That write path now delegates to `AssignmentService.completeAssignment()`,
 * which cascades all three transactionally, so no new drift is produced. This
 * migration repairs rows that drifted before that fix.
 *
 * Idempotent and safe to re-run: it only moves records forward, and only when
 * the assignment itself is already COMPLETED. A branch that has advanced past
 * AUDIT_COMPLETED (VALIDATION_COMPLETED / CLOSED) is never pulled back.
 *
 * Verified against the dev database on 2026-07-30: one affected row
 * (ASN-2026-4508 — assignment COMPLETED, branch SCHEDULED, schedule
 * RESCHEDULED). Re-check the affected-row count before running elsewhere; the
 * SELECT in `up()` logs it.
 */
export class ReconcileAssignmentStatusDrift1785700000000 implements MigrationInterface {
  name = 'ReconcileAssignmentStatusDrift1785700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const drifted = await queryRunner.query(`
      SELECT a.assignment_number, a.status AS asn_status,
             pb.status AS branch_status, s.status AS schedule_status
      FROM assignments a
      LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
      LEFT JOIN schedules s ON s.assignment_id = a.id AND s.is_active = true
      WHERE a.status = 'COMPLETED'
        AND (pb.status NOT IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED')
             OR (s.id IS NOT NULL AND s.status <> 'COMPLETED'))
    `);
    console.log(
      `[ReconcileAssignmentStatusDrift] ${drifted.length} assignment(s) with drifted status:`,
      drifted,
    );

    // Branch: advance to AUDIT_COMPLETED where the assignment is already COMPLETED.
    // The NOT IN guard keeps branches that are further along untouched.
    await queryRunner.query(`
      UPDATE project_branches pb
      SET status = 'AUDIT_COMPLETED', updated_at = NOW()
      FROM assignments a
      WHERE a.project_branch_id = pb.id
        AND a.status = 'COMPLETED'
        AND pb.status NOT IN ('AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED')
    `);

    // Schedule: mirror the completion, preserving any completed_at already recorded.
    await queryRunner.query(`
      UPDATE schedules s
      SET status = 'COMPLETED',
          completed_at = COALESCE(s.completed_at, NOW()),
          updated_at = NOW()
      FROM assignments a
      WHERE s.assignment_id = a.id
        AND s.is_active = true
        AND a.status = 'COMPLETED'
        AND s.status <> 'COMPLETED'
    `);

    // Un-soft-delete terminal assignments.
    //
    // `rejectOffer()` / `cancel()` used to set `is_active = false` alongside the terminal
    // status, overloading the soft-delete flag to mean "terminal". Readers that filter
    // `is_active = true` (dashboard summary, assayer stats) therefore disagreed with readers
    // that don't (the assignments list) about the very same records — the dashboard reported
    // 3 assignments while the list reported 5 — and `cancelled_assignments` was pinned at 0,
    // since its query filters `is_active = true` which the cancel had just cleared.
    //
    // Safe to restore unconditionally: assignments have no delete endpoint, and after the
    // accompanying state-machine fix no code path sets `is_active = false` on an assignment
    // at all, so every such row was produced by that behaviour and nothing else.
    const restored = await queryRunner.query(`
      UPDATE assignments
      SET is_active = true, updated_at = NOW()
      WHERE is_active = false
        AND status IN ('REJECTED', 'CANCELLED')
      RETURNING assignment_number, status
    `);
    console.log(
      `[ReconcileAssignmentStatusDrift] restored is_active on ${restored?.[0]?.length ?? 0} terminal assignment(s)`,
    );
  }

  /**
   * Not reversible. This migration reconciles corrupted state onto its correct
   * value; the prior per-row values were themselves the defect and are not
   * recoverable from the post-repair state. Rolling back would mean
   * deliberately re-corrupting the data, so `down()` intentionally no-ops.
   */
  public async down(): Promise<void> {
    // no-op — see above
  }
}
