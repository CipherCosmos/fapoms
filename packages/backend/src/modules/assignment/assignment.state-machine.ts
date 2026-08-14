import { BadRequestException } from '@nestjs/common';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';

export class AssignmentStateMachine {
  private static readonly VALID_PATHS: Record<AssignmentStatus, AssignmentStatus[]> = {
    [AssignmentStatus.PENDING]: [AssignmentStatus.ACCEPTED, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED],
    [AssignmentStatus.ACCEPTED]: [AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.CANCELLED],
    [AssignmentStatus.CHECKED_IN]: [AssignmentStatus.CHECKED_IN, AssignmentStatus.ACCEPTED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    // CHECKED_IN is reachable from IN_PROGRESS because a field check-in is retried: a flaky
    // mobile connection, a GPS refresh, or a second attempt at the geofence all re-issue it
    // after work has already started. Refusing that would fail a legitimate retry, so it is
    // allowed here rather than being a backwards move nobody intended.
    [AssignmentStatus.IN_PROGRESS]: [AssignmentStatus.IN_PROGRESS, AssignmentStatus.CHECKED_IN, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    [AssignmentStatus.COMPLETED]: [],
    [AssignmentStatus.REJECTED]: [AssignmentStatus.PENDING],
    [AssignmentStatus.CANCELLED]: [AssignmentStatus.PENDING],
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
   * Completion must go through the machine like every other transition. Bypassing it let an
   * assignment be marked COMPLETED straight from PENDING/ACCEPTED — no on-site check-in, no
   * evidence — which then triggered the auto-bill listener and produced a real client invoice
   * and assayer payable for a visit that never happened. VALID_PATHS only permits
   * CHECKED_IN/IN_PROGRESS -> COMPLETED, so this refuses completion of work that was never begun.
   */
  static completeAudit(assignment: AssignmentEntity, userId: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.COMPLETED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.COMPLETED;
    return { previousState: prev, newState: assignment.status, userId };
  }
}
