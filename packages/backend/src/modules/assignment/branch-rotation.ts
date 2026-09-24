import { AssignmentStatus } from '@fapoms/shared';
import { ENGAGED_ASSIGNMENT_STATUSES, sqlStatusList } from './assignment-workload';

/**
 * THE ROTATION RULE — who "audited this branch last", asked one way everywhere.
 *
 * Owner decision 2026-09-25: the no-repeat-auditor rule is enforced when work is placed — create,
 * reassign, bulk offer, day-plan commit and plan deploy — as an OVERRIDABLE rule (a written reason
 * waives it and is recorded as `ASSIGNMENT_ELIGIBILITY_OVERRIDDEN` with rule
 * `REPEAT_AUDITOR_ROTATION`). The recommendation engine excludes the same person for the same
 * reason. Both read this file, so the list an operator is shown and the refusal they get cannot
 * disagree about who the last auditor was.
 *
 * "Last auditor" is the assayer of the branch's most recent assignment that
 *  - somebody actually took on: ACCEPTED, CHECKED_IN, IN_PROGRESS or COMPLETED
 *    (`ENGAGED_ASSIGNMENT_STATUSES`). A PENDING offer, a declined one or a cancelled one is not an
 *    audit anybody did, so it never makes anyone "the last auditor"; and
 *  - belongs to an EARLIER project than the one being planned. The current project's own live
 *    holder is this cycle's auditor, not the previous cycle's — counting them would make the rule
 *    bar the person already doing the work from being re-offered it (a reassign back, a re-create
 *    after a decline elsewhere). "Earlier" is read as "a different project"; the most recent such
 *    row by audit date wins.
 *
 * Before this, the engine looked at the branch's newest row of ANY status in ANY project (so a
 * pending offer could hide the real last auditor, and the current project's holder was treated as
 * the previous one), and the write path did not check the rule at all.
 */
export const ROTATION_LOCKING_STATUSES: readonly AssignmentStatus[] = ENGAGED_ASSIGNMENT_STATUSES;

export interface LastBranchAuditor {
  assayerId: string;
  assignmentId: string;
  projectId: string | null;
  status: AssignmentStatus;
  /** YYYY-MM-DD of the audit (scheduled date, else the day the row was created). */
  auditDate: string | null;
}

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any[]> };

/** Marker the unit tests use to recognise this query in a hand-rolled repository double. */
export const LAST_AUDITOR_QUERY_MARKER = '/* branch-rotation:last-auditor */';

export async function findLastBranchAuditor(
  runner: Runner,
  branchId: string | null | undefined,
  currentProjectId: string | null | undefined,
): Promise<LastBranchAuditor | null> {
  if (!branchId) return null;
  const rows = await runner.query(
    `${LAST_AUDITOR_QUERY_MARKER}
     SELECT a.id, a.assayer_id, a.project_id, a.status,
            to_char(COALESCE(a.scheduled_date, a.created_at::date), 'YYYY-MM-DD') AS audit_date
       FROM assignments a
       JOIN project_branches pb ON pb.id = a.project_branch_id
      WHERE pb.branch_id = $1
        AND a.is_active = true
        AND a.status IN (${sqlStatusList([...ROTATION_LOCKING_STATUSES])})
        AND ($2::uuid IS NULL OR a.project_id IS DISTINCT FROM $2::uuid)
      ORDER BY COALESCE(a.scheduled_date, a.created_at::date) DESC, a.created_at DESC, a.id DESC
      LIMIT 1`,
    [branchId, currentProjectId ?? null],
  );
  const r = Array.isArray(rows) ? rows[0] : null;
  if (!r || !r.assayer_id) return null;
  return {
    assayerId: r.assayer_id,
    assignmentId: r.id,
    projectId: r.project_id ?? null,
    status: r.status as AssignmentStatus,
    auditDate: r.audit_date ?? null,
  };
}

/** Does the rotation rule bar this assayer? Pure, so the engine and the write path share it. */
export function rotationBars(last: Pick<LastBranchAuditor, 'assayerId' | 'status'> | null | undefined, assayerId: string): boolean {
  if (!last || !assayerId) return false;
  return last.assayerId === assayerId && ROTATION_LOCKING_STATUSES.includes(last.status);
}

/** The refusal sentence, naming the audit that makes them the last auditor. */
export function rotationBarredReason(last: Pick<LastBranchAuditor, 'auditDate'>, who: string): string {
  return `${who} audited this branch last${last.auditDate ? ` (${last.auditDate})` : ''} — the rotation rule wants a different auditor this cycle.`;
}
