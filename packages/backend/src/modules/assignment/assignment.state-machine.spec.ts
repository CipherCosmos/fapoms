import { AssignmentStateMachine } from './assignment.state-machine';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
import { BadRequestException } from '@nestjs/common';

describe('AssignmentStateMachine', () => {
  let assignment: AssignmentEntity;

  beforeEach(() => {
    assignment = {
      id: 'assign-1',
      status: AssignmentStatus.PENDING,
      proposedFee: 1000,
    } as AssignmentEntity;
  });

  it('should transition from PENDING to ACCEPTED', () => {
    const event = AssignmentStateMachine.acceptOffer(assignment, 'user-1');
    expect(assignment.status).toBe(AssignmentStatus.ACCEPTED);
    expect(event.previousState).toBe(AssignmentStatus.PENDING);
    expect(event.newState).toBe(AssignmentStatus.ACCEPTED);
  });

  it('should transition from PENDING to REJECTED', () => {
    const event = AssignmentStateMachine.rejectOffer(assignment, 'user-1', 'Not interested');
    expect(assignment.status).toBe(AssignmentStatus.REJECTED);
    expect(assignment.rejectReason).toBe('Not interested');
    expect(assignment.isActive).toBe(false);
  });

  it('should throw BadRequestException on invalid transition from ACCEPTED to REJECTED', () => {
    AssignmentStateMachine.acceptOffer(assignment, 'user-1');
    expect(() => {
      AssignmentStateMachine.rejectOffer(assignment, 'user-1');
    }).toThrow(BadRequestException);
  });

  it('should transition from ACCEPTED to CANCELLED', () => {
    AssignmentStateMachine.acceptOffer(assignment, 'user-1');
    const event = AssignmentStateMachine.cancel(assignment, 'user-1', 'Admin override');
    expect(assignment.status).toBe(AssignmentStatus.CANCELLED);
    expect(assignment.cancelReason).toBe('Admin override');
  });
});
