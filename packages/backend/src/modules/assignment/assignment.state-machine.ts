import { BadRequestException } from '@nestjs/common';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';

export class AssignmentStateMachine {
  private static readonly VALID_PATHS: Record<AssignmentStatus, AssignmentStatus[]> = {
    [AssignmentStatus.PENDING]: [AssignmentStatus.ACCEPTED, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED],
    // COMPLETED is reachable from ACCEPTED, but only through `completeAudit`, which refuses it
    // without a stated reason — see there. The desk cannot check in for somebody (the check-in
    // is geofenced and lives in the field app), so without this a job whose assayer never
    // opened the app could not be closed at all.
    [AssignmentStatus.ACCEPTED]: [
      AssignmentStatus.ACCEPTED,
      AssignmentStatus.CHECKED_IN,
      AssignmentStatus.COMPLETED,
      AssignmentStatus.CANCELLED,
    ],
    [AssignmentStatus.CHECKED_IN]: [AssignmentStatus.CHECKED_IN, AssignmentStatus.ACCEPTED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    // CHECKED_IN is reachable from IN_PROGRESS because a field check-in is retried: a flaky
    // mobile connection, a GPS refresh, or a second attempt at the geofence all re-issue it
    // after work has already started. Refusing that would fail a legitimate retry, so it is
    // allowed here rather than being a backwards move nobody intended.
    [AssignmentStatus.IN_PROGRESS]: [AssignmentStatus.IN_PROGRESS, AssignmentStatus.CHECKED_IN, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    // COMPLETED is a terminal workflow state that cannot be exited through generic transition endpoints.
    // Reopening is strictly a privileged back-office operational command via AssignmentStateMachine.reopen().
    [AssignmentStatus.COMPLETED]: [],
    // A declined offer goes back on the market: reassigning it to somebody else is the whole
    // point, and it re-enters as a PENDING offer to that person.
    [AssignmentStatus.REJECTED]: [AssignmentStatus.PENDING],
    /**
     * Terminal. A cancellation is a decision that this work is not happening.
     *
     * This used to list PENDING, so the table declared that cancelled work could quietly become
     * a live offer again. Nothing in the API could reach that edge — `POST :id/transition` has no
     * PENDING branch at all — but `reassignAssignment` set the status directly, bypassing this
     * table entirely, and so DID revive cancelled assignments: new owner, `cancel_reason` wiped,
     * under an audit event that said only "reassigned". That path now refuses CANCELLED, and the
     * table is corrected to match, so the declared machine and the enforced one agree.
     *
     * Reviving cancelled work needs its own command with its own permission, reason and audit —
     * see `reopen()` below for the shape that takes. It is not an edge on this table.
     */
    [AssignmentStatus.CANCELLED]: [],
  };

  private static validateTransition(current: AssignmentStatus, target: AssignmentStatus) {
    if (!AssignmentStateMachine.canTransition(current, target)) {
      throw new BadRequestException(`Invalid transition path from '${current}' to '${target}'`);
    }
  }

  /**
   * The same question `validateTransition` asks, answered rather than thrown.
   *
   * Check-in comes from the mobile app and reports refusals as a result object with a message
   * the assayer can act on, not as a 400 — so it needs to ask permission without an exception.
   * It exists so that path can consult VALID_PATHS instead of keeping its own list: check-in
   * previously carried a local `CHECK_IN_ALLOWED_FROM` array that had drifted out of agreement
   * with the table above, leaving two answers to "may this assignment be checked in" and no way
   * to tell which one the system actually used.
   */
  static canTransition(current: AssignmentStatus, target: AssignmentStatus): boolean {
    return AssignmentStateMachine.VALID_PATHS[current]?.includes(target) ?? false;
  }

  /**
   * Arriving on site. Written through the machine like every other transition — see
   * `canTransition` for why this one is also askable without throwing.
   */
  static checkIn(assignment: AssignmentEntity, userId: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.CHECKED_IN);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CHECKED_IN;
    return { previousState: prev, newState: assignment.status, userId };
  }

  static acceptOffer(assignment: AssignmentEntity, userId: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.ACCEPTED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.ACCEPTED;
    return { previousState: prev, newState: assignment.status, userId };
  }

  // NOTE ON `isActive`: REJECTED and CANCELLED are terminal *states*, not deletions, and the
  // ops UI deliberately surfaces them (the "Needs Attention" and "Cancelled/Rejected" views).
  // These transitions used to also set `isActive = false`, which overloaded the soft-delete
  // flag to mean "terminal". That made every isActive-filtered reader disagree with every
  // unfiltered one for the same records — e.g. the dashboard summary counted 3 assignments
  // while the assignments list counted 5, and `cancelledAssignments` could never be anything
  // but 0 (its query filters isActive=true, which the cancel itself had just cleared).
  // Terminal state is expressed by `status` alone; `isActive` stays reserved for real deletion.

  static rejectOffer(assignment: AssignmentEntity, userId: string, reason?: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.REJECTED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.REJECTED;
    assignment.rejectReason = reason ?? 'Rejected';
    return { previousState: prev, newState: assignment.status, userId };
  }

  static cancel(assignment: AssignmentEntity, userId: string, reason?: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.CANCELLED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CANCELLED;
    assignment.cancelReason = reason ?? 'Cancelled';
    return { previousState: prev, newState: assignment.status, userId };
  }

  /**
   * Closing out the field work.
   *
   * Completion triggers the auto-bill listener: a real client invoice line and a real assayer
   * payable. So an assignment marked done straight from PENDING — an offer nobody even
   * accepted — would bill for a visit that never happened, and VALID_PATHS still refuses that.
   *
   * The check-in is the evidence that somebody attended, and it is a geofenced action in the
   * field app. The desk cannot perform one. That left an accepted job whose assayer never
   * opened the app impossible to close by anyone, which is not a safeguard — it is a dead end,
   * and it is what operations hit. The desk may close it, and must say why: a job completed
   * without a check-in behind it records the reason on the assignment, so money booked on
   * somebody's word rather than on attendance is visible wherever the job is reviewed.
   *
   * The test is `checkedInAt`, not the status — that is the actual evidence, and it survives an
   * assignment moving back and forth between CHECKED_IN and IN_PROGRESS on a retried check-in.
   */
  /**
   * Starting work on site.
   *
   * Added because `AssignmentService` was setting `IN_PROGRESS` by hand. Its `start` branch
   * assigned `assignment.status` directly with no validation at all, while the ACCEPTED, REJECTED
   * and CANCELLED branches beside it all went through this class — so `POST /assignments/:id/start`
   * moved a brand-new PENDING offer straight to IN_PROGRESS, with `checked_in_at` still null. The
   * assayer had never accepted it and had never been anywhere near the branch.
   *
   * `VALID_PATHS` says work starts from CHECKED_IN, and that is the whole point of the ordering:
   * the check-in is geofenced, so "in progress" is supposed to mean somebody is actually there.
   * Writing the column directly skipped both the acceptance record and the geofence.
   */
  static startWork(assignment: AssignmentEntity, userId: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.IN_PROGRESS);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.IN_PROGRESS;
    return { previousState: prev, newState: assignment.status, userId };
  }

  static completeAudit(assignment: AssignmentEntity, userId: string, reason?: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.COMPLETED);

    const attended = !!assignment.checkedInAt;
    const departed = !!assignment.checkedOutAt;
    const stated = (reason ?? '').trim();
    if (!attended && !stated) {
      throw new BadRequestException(
        'This assignment has no check-in, so completing it books the payout and the client '
        + 'line on your word alone. Say why it is being closed without one.',
      );
    }
    /**
     * The departure half of the same rule.
     *
     * Time on site is the span between the check-in and the check-out, and for a bank collateral
     * audit that span IS the attendance evidence — `operational-integrity.service.ts` has called
     * both timestamps "attendance evidence" since it was written. But `checked_out_at` is set in
     * exactly one place, the check-out route, and `CHECKED_IN → COMPLETED` is a legal edge that
     * uploading the audited return takes directly. So the ordinary way to finish a job silently
     * ended the visit with no record of when the assayer left, and the census bore that out:
     * 15 completed audits with an arrival and no departure, against one departure in the table.
     *
     * The fix is deliberately NOT to stamp `checkedOutAt` here. That column means "the assayer
     * left the branch at this moment"; filling it at completion would write a departure nobody
     * observed into the field a travel claim and an audit defence are later read out of. A
     * manufactured observation is worse than a missing one, because the gap is visible and the
     * fiction is not. So completion asks for the departure, and failing that asks why there
     * isn't one — the same bargain the check-in rule above already strikes.
     *
     * Only when there IS an arrival: with no check-in at all the branch above has already taken
     * a reason for the whole absent visit, and writing it into both columns would leave neither
     * meaning anything precise.
     */
    if (attended && !departed && !stated) {
      throw new BadRequestException(
        'Nobody checked out of this branch, so there is no record of when the assayer left and '
        + 'no time on site to show a client. Check out from the field app if the visit is still '
        + 'open, or say why this one is being closed without a departure.',
      );
    }
    if (!attended) assignment.completedWithoutCheckInReason = stated;
    else if (!departed) assignment.completedWithoutCheckOutReason = stated;

    const prev = assignment.status;
    assignment.status = AssignmentStatus.COMPLETED;
    return { previousState: prev, newState: assignment.status, userId };
  }

  /**
   * Undo a completion that should not have booked money — the assignment half of voiding a
   * payable. Gated by the same roles as `voidPayable` at the call site, because reopening
   * without also voiding the payable would leave a live obligation for work the record now says
   * is not finished, and voiding without reopening would leave COMPLETED work with no path back
   * to being closed correctly.
   */
  static reopen(assignment: AssignmentEntity, userId: string, reason: string) {
    if (assignment.status !== AssignmentStatus.COMPLETED) {
      throw new BadRequestException(
        `Cannot reopen assignment in state '${assignment.status}'. Only COMPLETED assignments can be reopened.`,
      );
    }
    const stated = (reason ?? '').trim();
    if (!stated) {
      throw new BadRequestException('A reason is required to reopen a completed assignment.');
    }
    const prev = assignment.status;
    assignment.status = AssignmentStatus.ACCEPTED;
    assignment.completionDate = null;
    assignment.completedWithoutCheckInReason = null;
    // Both explanations belong to the completion being undone. Left behind, the next completion
    // of this assignment would carry the previous one's excuse for a gap that may no longer
    // exist — and if the assayer does check out this time, the record would say a departure was
    // both present and explained away.
    assignment.completedWithoutCheckOutReason = null;
    assignment.remarks = stated;
    return { previousState: prev, newState: assignment.status, userId };
  }
}
