import { BadRequestException } from '@nestjs/common';
import { AssignmentStatus } from '@fapoms/shared';
import { AssignmentStateMachine } from './assignment.state-machine';
import { AssignmentEntity } from './assignment.entity';

/**
 * Closing out a job the assayer arrived at and never left — on the record, anyway.
 *
 * The departure half of `completion-without-check-in.spec.ts`, and the half that actually went
 * missing. `checked_out_at` is written in exactly one place, the check-out route in the field
 * app, and `CHECKED_IN → COMPLETED` is a legal edge that uploading the audited return takes
 * directly. On the phone that upload is the primary button and check out is secondary, so the
 * ordinary way to finish a job was the way that lost the record — and the database showed it:
 * 15 completed audits with an arrival and no departure, against one departure in the whole table.
 *
 * Time on site is the span between the two timestamps, and for a bank collateral audit that span
 * is attendance evidence: it is what a travel claim is checked against and what a client is shown.
 *
 * The thing these tests exist to stop coming back is not the refusal — it is the tempting fix.
 * Stamping `checkedOutAt` at completion would make every case below pass and would write a
 * departure time nobody observed into the column an audit defence is later read out of. A
 * manufactured observation is worse than a missing one, because a gap is visible and a fiction
 * is not. So: the state machine must never invent a timestamp, and that is asserted directly.
 */
describe('completing an assignment without a check-out', () => {
  const arrival = new Date('2026-08-20T09:00:00Z');
  const departure = new Date('2026-08-20T11:15:00Z');

  const assignment = (over: Partial<AssignmentEntity> = {}): AssignmentEntity => ({
    id: 'asn-1',
    status: AssignmentStatus.CHECKED_IN,
    checkedInAt: arrival,
    checkedOutAt: null,
    completedWithoutCheckInReason: null,
    completedWithoutCheckOutReason: null,
    ...over,
  } as AssignmentEntity);

  describe('when the visit has both ends on record', () => {
    const complete = () => assignment({ checkedOutAt: departure });

    it('completes with nothing to explain', () => {
      const a = complete();
      const event = AssignmentStateMachine.completeAudit(a, 'user-1');

      expect(a.status).toBe(AssignmentStatus.COMPLETED);
      expect(event.previousState).toBe(AssignmentStatus.CHECKED_IN);
    });

    it('records no reason even when one is offered', () => {
      const a = complete();
      // The column means "closed with no departure on record", and this was not that. A value
      // here on a complete visit would report a gap that does not exist.
      AssignmentStateMachine.completeAudit(a, 'user-1', 'not needed');

      expect(a.completedWithoutCheckOutReason).toBeNull();
      expect(a.completedWithoutCheckInReason).toBeNull();
    });

    it('leaves both attendance timestamps exactly as the field app wrote them', () => {
      const a = complete();
      AssignmentStateMachine.completeAudit(a, 'user-1');

      expect(a.checkedInAt).toBe(arrival);
      expect(a.checkedOutAt).toBe(departure);
    });
  });

  describe('when the assayer arrived and never checked out', () => {
    it('refuses without a reason, and names the missing evidence', () => {
      const a = assignment();

      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(BadRequestException);
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(/checked out/i);
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(/time on site/i);
      // Refused means refused: the status must not have moved.
      expect(a.status).toBe(AssignmentStatus.CHECKED_IN);
    });

    it('points at the check-out before it offers the reason', () => {
      // The check-out is the real evidence and the assayer may still be able to give it. A
      // message that leads with "state a reason" teaches the desk to take the shortcut.
      const a = assignment();
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(/field app/i);
    });

    it('treats a blank reason as no reason', () => {
      const a = assignment();
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1', '   ')).toThrow(BadRequestException);
      expect(a.status).toBe(AssignmentStatus.CHECKED_IN);
    });

    it('closes the job when a reason is given, and keeps it trimmed', () => {
      const a = assignment();

      AssignmentStateMachine.completeAudit(a, 'user-1', '  Left at ~4pm; phone battery died.  ');

      expect(a.status).toBe(AssignmentStatus.COMPLETED);
      expect(a.completedWithoutCheckOutReason).toBe('Left at ~4pm; phone battery died.');
    });

    it('DOES NOT invent a departure timestamp — the whole point of the reason', () => {
      const a = assignment();

      AssignmentStateMachine.completeAudit(a, 'user-1', 'Phone battery died.');

      // If this ever goes green with a Date in it, the product is presenting a time nobody
      // observed as an observation, in the column a travel claim and an audit defence read.
      expect(a.checkedOutAt).toBeNull();
    });

    it('does not borrow the check-in column for the departure explanation', () => {
      const a = assignment();

      AssignmentStateMachine.completeAudit(a, 'user-1', 'Phone battery died.');

      // Two different questions, two different columns. One reason written into both would make
      // "closed with no arrival" and "closed with no departure" indistinguishable afterwards.
      expect(a.completedWithoutCheckInReason).toBeNull();
    });

    it('applies from IN_PROGRESS as well as CHECKED_IN', () => {
      const a = assignment({ status: AssignmentStatus.IN_PROGRESS });
      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(/checked out/i);

      AssignmentStateMachine.completeAudit(a, 'user-1', 'Left before the app came back online.');
      expect(a.status).toBe(AssignmentStatus.COMPLETED);
      expect(a.completedWithoutCheckOutReason).toBe('Left before the app came back online.');
    });
  });

  describe('when there was no arrival either', () => {
    it('asks about the check-in, not the check-out', () => {
      const a = assignment({ status: AssignmentStatus.ACCEPTED, checkedInAt: null });

      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(/books the payout/i);
    });

    it('records the one stated reason against the arrival only', () => {
      const a = assignment({ status: AssignmentStatus.ACCEPTED, checkedInAt: null });

      AssignmentStateMachine.completeAudit(a, 'user-1', 'Assayer never opened the app.');

      // A visit with no arrival at all is already fully explained by one reason. Writing it into
      // both columns would leave neither meaning anything precise, and would make the departure
      // rule report an extra finding for a visit that never started.
      expect(a.completedWithoutCheckInReason).toBe('Assayer never opened the app.');
      expect(a.completedWithoutCheckOutReason).toBeNull();
    });
  });

  describe('across a reopen and a re-completion', () => {
    it('clears the departure explanation with the completion it belonged to', () => {
      const a = assignment();
      AssignmentStateMachine.completeAudit(a, 'user-1', 'Phone battery died.');

      AssignmentStateMachine.reopen(a, 'user-2', 'Wrong branch audited.');

      expect(a.status).toBe(AssignmentStatus.ACCEPTED);
      expect(a.completedWithoutCheckOutReason).toBeNull();
      expect(a.completedWithoutCheckInReason).toBeNull();
      expect(a.completionDate).toBeNull();
    });

    it('asks again on the next completion rather than riding on the old excuse', () => {
      const a = assignment();
      AssignmentStateMachine.completeAudit(a, 'user-1', 'Phone battery died.');
      AssignmentStateMachine.reopen(a, 'user-2', 'Wrong branch audited.');

      expect(() => AssignmentStateMachine.completeAudit(a, 'user-1')).toThrow(BadRequestException);
    });

    it('stops asking once a real check-out arrives', () => {
      const a = assignment();
      AssignmentStateMachine.completeAudit(a, 'user-1', 'Phone battery died.');
      AssignmentStateMachine.reopen(a, 'user-2', 'Wrong branch audited.');

      // The redo is done properly this time: the assayer checks out.
      a.status = AssignmentStatus.CHECKED_IN;
      a.checkedOutAt = departure;
      AssignmentStateMachine.completeAudit(a, 'user-1');

      expect(a.status).toBe(AssignmentStatus.COMPLETED);
      expect(a.completedWithoutCheckOutReason).toBeNull();
    });
  });
});
