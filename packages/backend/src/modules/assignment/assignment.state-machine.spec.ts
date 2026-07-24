import { AssignmentStateMachine } from './assignment.state-machine';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentStatus } from '@fapoms/shared';
import { BadRequestException } from '@nestjs/common';

describe('AssignmentStateMachine', () => {
  let assignment: AssignmentEntity;

  beforeEach(() => {
    assignment = {
      id: 'assign-1',
      status: AssignmentStatus.CREATED,
      proposedFee: 1000,
    } as AssignmentEntity;
  });

  it('should transition from CREATED to CANDIDATE_SELECTED', () => {
    const event = AssignmentStateMachine.selectCandidate(assignment, 'user-1');
    expect(assignment.status).toBe(AssignmentStatus.CANDIDATE_SELECTED);
    expect(event.previousState).toBe(AssignmentStatus.CREATED);
    expect(event.newState).toBe(AssignmentStatus.CANDIDATE_SELECTED);
  });

  it('should throw BadRequestException on invalid transition', () => {
    expect(() => {
      AssignmentStateMachine.scheduleAudit(assignment, '2026-08-01', 'user-1');
    }).toThrow(BadRequestException);
  });
});
