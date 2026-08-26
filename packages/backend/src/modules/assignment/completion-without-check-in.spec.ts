import { BadRequestException } from '@nestjs/common';
import { AssignmentStatus } from '@fapoms/shared';
import { AssignmentStateMachine } from './assignment.state-machine';
import { AssignmentEntity } from './assignment.entity';

/**
 * Closing out a job the assayer never checked in for.
 *
 * Completion books money — the auto-bill listener raises the assayer's payable and the client's
 * billing line off it — so the rule was that only attended work completes, and attendance means
 * a check-in. A check-in is a geofenced action that exists only in the field app.
 *
 * The desk cannot perform one. So an accepted job whose assayer never opened the app could not
 * be closed by anybody: the field app refuses completion as a back-office decision, and the
 * back office was refused with "Invalid transition path from 'ACCEPTED' to 'COMPLETED'". Every
 * such job was stuck, which is what operations reported.
 *
 * The desk may close it now and must say why. What must not come back is the original defect
 * these paths were locked down for: billing a visit that never happened, silently.
 */
describe('completing an assignment', () => {
  const assignment = (over: Partial<AssignmentEntity> = {}): AssignmentEntity => ({
    id: 'asn-1',
    status: AssignmentStatus.ACCEPTED,
    checkedInAt: null,
    completedWithoutCheckInReason: null,
    ...over,
  } as AssignmentEntity);

  describe('when the assayer checked in', () => {
    const attended = () =>
      assignment({ status: AssignmentStatus.CHECKED_IN, checkedInAt: new Date('2026-08-20T09:00:00Z') });

    it('completes without anyone having to explain themselves', () => {
      const a = attended();
      const event = AssignmentStateMachine.completeAudit(a, 'user-1');

      expect(a.status).toBe(AssignmentStatus.COMPLETED);
      expect(event.previousState).toBe(AssignmentStatus.CHECKED_IN);
    });

    it('records no reason, because there is nothing to account for', () => {
      const a = attended();
      // Even when one is offered — the field means "closed without evidence", and this was not.
      AssignmentStateMachine.completeAudit(a, 'user-1', 'not needed');

      expect(a.completedWithoutCheckInReason).toBeNull();
    });

    it('completes from IN_PROGRESS too', () => {
      const a = assignment({ status: AssignmentStatus.IN_PROGRESS, checkedInAt: new Date() });
      AssignmentStateMachine.completeAudit(a, 'user-1');
      expect(a.status).toBe(AssignmentStatus.COMPLETED);
    });
  });

  describe('when there is no check-in behind it', () => {
    it('refuses without a reason, and says what completing would do', () => {
      const a = assignment();

      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(BadRequestException);
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(/books the payout/i);
      // Refused means refused: the status must not have moved.
      expect(a.status).toBe(AssignmentStatus.ACCEPTED);
    });

    it('treats a blank reason as no reason', () => {
      const a = assignment();
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1', '   ')).toThrow(BadRequestException);
    });

    it('closes the job when a reason is given, and keeps it', () => {
      const a = assignment();

      AssignmentStateMachine.completeAudit(a, 'user-1', '  Attended; phone had no signal at the branch.  ');

      expect(a.status).toBe(AssignmentStatus.COMPLETED);
      // Trimmed, so a stray space cannot be the difference between accounted for and not.
      expect(a.completedWithoutCheckInReason).toBe('Attended; phone had no signal at the branch.');
    });
  });

  describe('what stays refused', () => {
    it('will not complete an offer nobody accepted, reason or not', () => {
      // The original defect: billing a visit for work that was never even taken on.
      const a = assignment({ status: AssignmentStatus.PENDING });

      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1', 'they did it, honest'))
        .toThrow(/Invalid transition path/);
      expect(a.status).toBe(AssignmentStatus.PENDING);
    });

    it.each([AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED, AssignmentStatus.COMPLETED])(
      'will not complete from %s',
      (status) => {
        const a = assignment({ status });
        expect(() => AssignmentStateMachine.completeAudit(a, 'user-1', 'because')).toThrow(/Invalid transition path/);
      },
    );
  });
});
