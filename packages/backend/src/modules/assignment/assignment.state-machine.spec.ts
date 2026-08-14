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
      isActive: true,
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
    expect(event.newState).toBe(AssignmentStatus.REJECTED);
  });

  // A terminal status is not a deletion. Clearing isActive here made every isActive-filtered
  // reader (dashboard summary, assayer stats) disagree with unfiltered ones (assignments list)
  // about the same records, and pinned `cancelledAssignments` at 0 permanently.
  it('should NOT clear isActive when rejecting — terminal state is not a soft delete', () => {
    AssignmentStateMachine.rejectOffer(assignment, 'user-1', 'Not interested');
    expect(assignment.isActive).toBe(true);
  });

  it('should NOT clear isActive when cancelling — terminal state is not a soft delete', () => {
    AssignmentStateMachine.acceptOffer(assignment, 'user-1');
    AssignmentStateMachine.cancel(assignment, 'user-1', 'Admin override');
    expect(assignment.isActive).toBe(true);
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

  describe('check-in — one authority, not two', () => {
    const at = (status: AssignmentStatus) => ({ status }) as AssignmentEntity;

    it('accepts a check-in from an accepted assignment', () => {
      const a = at(AssignmentStatus.ACCEPTED);
      expect(AssignmentStateMachine.checkIn(a, 'u1').newState).toBe(AssignmentStatus.CHECKED_IN);
    });

    it('accepts a repeated check-in, because the field app retries them', () => {
      // A flaky connection or a second geofence attempt re-issues the check-in. Refusing the
      // retry would strand an assayer who is standing at the branch.
      expect(() => AssignmentStateMachine.checkIn(at(AssignmentStatus.CHECKED_IN), 'u1')).not.toThrow();
      expect(() => AssignmentStateMachine.checkIn(at(AssignmentStatus.IN_PROGRESS), 'u1')).not.toThrow();
    });

    it('refuses a check-in on work that was never accepted', () => {
      // The path that matters: PENDING -> CHECKED_IN -> COMPLETED would satisfy completeAudit's
      // guard and auto-bill a client for a visit to an assignment nobody ever took.
      expect(() => AssignmentStateMachine.checkIn(at(AssignmentStatus.PENDING), 'u1')).toThrow(BadRequestException);
    });

    it('refuses a check-in on a terminal assignment', () => {
      for (const s of [AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED]) {
        expect(() => AssignmentStateMachine.checkIn(at(s), 'u1')).toThrow(BadRequestException);
      }
    });

    it('answers the same question canTransition answers, so the service cannot drift from it', () => {
      // The service asks canTransition to build a friendly refusal instead of a 400. If these
      // two ever diverge, the app would refuse what the machine permits, or vice versa — which
      // is exactly the bug that came from keeping a separate CHECK_IN_ALLOWED_FROM list.
      for (const s of Object.values(AssignmentStatus)) {
        const permitted = AssignmentStateMachine.canTransition(s, AssignmentStatus.CHECKED_IN);
        let threw = false;
        try { AssignmentStateMachine.checkIn(at(s), 'u1'); } catch { threw = true; }
        expect(threw).toBe(!permitted);
      }
    });
  });
});
