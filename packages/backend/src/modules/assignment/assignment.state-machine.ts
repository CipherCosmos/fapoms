import { BadRequestException } from '@nestjs/common';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';

export class AssignmentStateMachine {
  private static readonly VALID_PATHS: Record<AssignmentStatus, AssignmentStatus[]> = {
    [AssignmentStatus.PENDING]: [AssignmentStatus.ACCEPTED, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED],
    [AssignmentStatus.ACCEPTED]: [AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.CANCELLED],
    [AssignmentStatus.CHECKED_IN]: [AssignmentStatus.CHECKED_IN, AssignmentStatus.ACCEPTED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    [AssignmentStatus.IN_PROGRESS]: [AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED],
    [AssignmentStatus.COMPLETED]: [],
    [AssignmentStatus.REJECTED]: [AssignmentStatus.PENDING],
    [AssignmentStatus.CANCELLED]: [AssignmentStatus.PENDING],
  };

  private static validateTransition(current: AssignmentStatus, target: AssignmentStatus) {
    const allowed = AssignmentStateMachine.VALID_PATHS[current];
    if (!allowed || !allowed.includes(target)) {
      throw new BadRequestException(`Invalid transition path from '${current}' to '${target}'`);
    }
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
}
