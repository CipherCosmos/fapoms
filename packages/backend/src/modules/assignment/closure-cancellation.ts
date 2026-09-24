import { ConflictException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { AssignmentStatus, EventCategory } from '@fapoms/shared';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { AuditService } from '../../core/audit/audit.service';

/**
 * Cancelling the open work under a branch that is being closed or a project that is being
 * stopped — the one implementation `BranchService.remove` and `ProjectService.cancelProject` share.
 *
 * Both used to (a) read the assignments with no lock, (b) refuse if any was on site, then (c) run
 * an unconditional `UPDATE … SET status = 'CANCELLED' WHERE id = $1` per row, outside any
 * transaction (the project path's comment said "transactionally" over a `dataSource.query` that
 * was not in the command's transaction at all). An assayer checking in between (b) and (c) had
 * their CHECKED_IN visit silently cancelled — the exact outcome the 409 in (b) exists to prevent —
 * and the cancelled jobs kept their CONFIRMED calendar entries and left location sharing on.
 *
 * Here, on the caller's transaction:
 *  1. every open assignment in scope is read `FOR UPDATE`, so no check-in can land until commit;
 *  2. the on-site refusal is decided on those locked rows;
 *  3. the cancel is conditional on the status still being PENDING/ACCEPTED, and a row that did not
 *     take it (it cannot, under the lock — this is the belt to that brace) refuses the closure;
 *  4. their schedules are retired the way a single cancel retires one (`retireSchedule`);
 *  5. the audit rows are written on the same transaction.
 *
 * Notifications, refresh pushes, realtime events and switching location sharing off are NOT done
 * here: they are side effects of a committed closure, so the callers run them after commit, from
 * the rows this returns.
 */

export interface ClosureCancelledAssignment {
  id: string;
  assignmentNumber: string;
  previousStatus: AssignmentStatus;
  assayerId: string | null;
  branchName: string | null;
  /** The version the cancellation committed — the notification's occurrence discriminator. */
  entityVersion: number;
  /** The job's day, so the assayer's travel for that day can be re-decided after commit. */
  scheduledDate: string | Date | null;
}

const CANCELLABLE: AssignmentStatus[] = [AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED];
const ON_SITE: AssignmentStatus[] = [AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS];

export async function cancelOpenAssignmentsForClosure(
  manager: EntityManager,
  opts: {
    scope: { branchId: string } | { projectId: string };
    userId: string;
    cancelReason: string;
    auditRemarks: string;
    /** The refusal when somebody is on site — the caller's existing 409 wording. */
    onSiteRefusal: (row: { assignmentNumber: string; status: string }) => Error;
    /** Written on `manager` — the closure's own transaction. */
    auditService: Pick<AuditService, 'recordEvent'>;
  },
): Promise<ClosureCancelledAssignment[]> {
  const byBranch = 'branchId' in opts.scope;
  const scopeId = byBranch ? (opts.scope as { branchId: string }).branchId : (opts.scope as { projectId: string }).projectId;

  // Ordered by id so two closures over overlapping rows take their locks in the same order.
  const rows: Array<{
    id: string;
    assignment_number: string;
    status: string;
    assayer_id: string | null;
    branch_name: string | null;
    scheduled_date?: string | Date | null;
  }> = await manager.query(
    `SELECT a.id, a.assignment_number, a.status, a.assayer_id, a.scheduled_date, b.name AS branch_name
       FROM assignments a
       INNER JOIN project_branches pb ON a.project_branch_id = pb.id
       LEFT JOIN branches b ON b.id = pb.branch_id
      WHERE ${byBranch ? 'pb.branch_id' : 'pb.project_id'} = $1 AND a.is_active = true
      ORDER BY a.id
      FOR UPDATE OF a`,
    [scopeId],
  );

  const onSite = rows.find((r) => ON_SITE.includes(r.status as AssignmentStatus));
  if (onSite) {
    throw opts.onSiteRefusal({ assignmentNumber: onSite.assignment_number, status: onSite.status });
  }

  const cancellable = rows.filter((r) => CANCELLABLE.includes(r.status as AssignmentStatus));
  if (cancellable.length === 0) return [];

  const ids = cancellable.map((r) => r.id);
  const updated: Array<{ id: string; entity_version: number }> = await manager.query(
    `UPDATE assignments
        SET status = 'CANCELLED',
            cancel_reason = $2,
            updated_by = $1,
            entity_version = COALESCE(entity_version, 1) + 1,
            updated_at = NOW()
      WHERE id = ANY($3::uuid[])
        AND status IN ('PENDING', 'ACCEPTED')
      RETURNING id, entity_version`,
    [opts.userId, opts.cancelReason, ids],
  ).then((r: any) => (Array.isArray(r?.[0]) ? r[0] : r) ?? []);

  const versionById = new Map(updated.map((u) => [u.id, Number(u.entity_version)]));
  const missed = cancellable.find((r) => !versionById.has(r.id));
  if (missed) {
    // Under the row lock this cannot happen; if it ever does, refusing (and rolling back every
    // cancel above with it) is the answer — never a closure that half-happened.
    throw new ConflictException(
      `Assignment ${missed.assignment_number} changed while the closure was running — nothing was cancelled. Try again.`,
    );
  }

  // Same retirement a single cancel performs (`AssignmentService.retireSchedule`): the visit is
  // not happening, so it leaves the calendar.
  await manager.getRepository(ScheduleEntity).update(
    { assignmentId: In(ids), isActive: true },
    { isActive: false, updatedBy: opts.userId },
  );

  for (const r of cancellable) {
    await opts.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSIGNMENT_CANCELLED',
      entityType: 'ASSIGNMENT',
      entityId: r.id,
      previousState: r.status,
      newState: AssignmentStatus.CANCELLED,
      userId: opts.userId,
      remarks: opts.auditRemarks,
      metadata: { entityVersion: versionById.get(r.id) },
    }, { manager });
  }

  return cancellable.map((r) => ({
    id: r.id,
    assignmentNumber: r.assignment_number,
    previousStatus: r.status as AssignmentStatus,
    assayerId: r.assayer_id,
    branchName: r.branch_name,
    entityVersion: versionById.get(r.id)!,
    scheduledDate: r.scheduled_date ?? null,
  }));
}
