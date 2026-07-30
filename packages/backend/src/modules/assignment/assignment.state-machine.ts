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

  static rejectOffer(assignment: AssignmentEntity, userId: string, reason?: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.REJECTED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.REJECTED;
    assignment.rejectReason = reason ?? 'Rejected';
    assignment.isActive = false;
    return { previousState: prev, newState: assignment.status, userId };
  }

  static cancel(assignment: AssignmentEntity, userId: string, reason?: string) {
    AssignmentStateMachine.validateTransition(assignment.status, AssignmentStatus.CANCELLED);
    const prev = assignment.status;
    assignment.status = AssignmentStatus.CANCELLED;
    assignment.cancelReason = reason ?? 'Cancelled';
    assignment.isActive = false;
    return { previousState: prev, newState: assignment.status, userId };
  }
}
