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

  /**
   * `reopen` is the assignment half of voiding a payable: an admin/ops actor undoing a
   * completion that should not have booked money. Only reachable from COMPLETED, and lands on
   * ACCEPTED — not CHECKED_IN — because `checkedInAt` is field evidence of a real visit and a
   * reopen must not manufacture that evidence.
   */
  describe('reopen', () => {
    const completed = () => ({
      id: 'assign-1', status: AssignmentStatus.COMPLETED,
      checkedInAt: new Date('2026-08-01T09:00:00Z'), completionDate: '2026-08-01',
      completedWithoutCheckInReason: 'phone had no signal', remarks: 'old remarks',
    } as unknown as AssignmentEntity);

    it('moves COMPLETED back to ACCEPTED and clears completion evidence', () => {
      const a = completed();
      const event = AssignmentStateMachine.reopen(a, 'admin-1', 'Completion voided — audit was reopened');

      expect(a.status).toBe(AssignmentStatus.ACCEPTED);
      expect(event.previousState).toBe(AssignmentStatus.COMPLETED);
      expect(event.newState).toBe(AssignmentStatus.ACCEPTED);
      // The mutation this proves: dropping these resets leaves a "reopened" assignment that
      // still LOOKS completed (a completionDate and a without-check-in reason on an ACCEPTED
      // record is an internally contradictory row).
      expect(a.completionDate).toBeNull();
      expect(a.completedWithoutCheckInReason).toBeNull();
      expect(a.remarks).toBe('Completion voided — audit was reopened');
    });

    it('does not fabricate check-in evidence — checkedInAt is untouched', () => {
      const a = completed();
      AssignmentStateMachine.reopen(a, 'admin-1', 'reason');
      // The real geofenced check-in the assayer made is still true and stays on the record;
      // reopen must not erase genuine evidence, only the completion built on top of it.
      expect(a.checkedInAt).toEqual(new Date('2026-08-01T09:00:00Z'));
    });

    // PENDING, ACCEPTED and CHECKED_IN already have their own independent paths to ACCEPTED in
    // VALID_PATHS (offer acceptance, and a retried check-in respectively) — reopen does not
    // change that, so they are not exercised here. IN_PROGRESS, REJECTED and CANCELLED have no
    // path to ACCEPTED at all; only `reopen`'s own COMPLETED entry could make one reachable.
    it.each([AssignmentStatus.IN_PROGRESS, AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED])(
      'refuses to reopen from %s',
      (status) => {
        const a = { ...completed(), status };
        expect(() => AssignmentStateMachine.reopen(a as AssignmentEntity, 'admin-1', 'reason')).toThrow(BadRequestException);
        expect(a.status).toBe(status);
      },
    );
  });
});
