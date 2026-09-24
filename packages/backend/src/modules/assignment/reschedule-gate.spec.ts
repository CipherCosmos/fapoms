import { AssignmentStatus } from '@fapoms/shared';
import { AssignmentService } from './assignment.service';

/**
 * B8 (2026-09-24): a new date only for an offer or an accepted job nobody has checked in to. The
 * gate sits in `scheduleAudit`, the funnel Scheduling's create/Reschedule and the desk route share.
 */
describe('rescheduling is refused once a visit is under way or over', () => {
  const codeOf = (fn: () => void) => { try { fn(); return null; } catch (e: any) { return e.getResponse?.()?.code ?? e.code; } };
  const job = (status: AssignmentStatus, checkedInAt: Date | null = null) =>
    ({ status, checkedInAt, assignmentNumber: 'ASN-7' }) as any;

  it.each([AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED])('allows %s without a check-in', (s) => {
    expect(codeOf(() => AssignmentService.assertReschedulable(job(s)))).toBeNull();
  });

  it('refuses an ACCEPTED job that already has a check-in (a reopened papers-only redo)', () => {
    expect(codeOf(() => AssignmentService.assertReschedulable(job(AssignmentStatus.ACCEPTED, new Date()))))
      .toBe('RESCHEDULE_NOT_ALLOWED');
  });

  it.each([
    AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED,
    AssignmentStatus.REJECTED, AssignmentStatus.CANCELLED,
  ])('refuses %s', (s) => {
    expect(codeOf(() => AssignmentService.assertReschedulable(job(s)))).toBe('RESCHEDULE_NOT_ALLOWED');
  });

  it('scheduleAudit refuses before checking any date', async () => {
    const svc: any = Object.create(AssignmentService.prototype);
    svc.findOne = jest.fn(async () => job(AssignmentStatus.CHECKED_IN, new Date()));
    svc.constraintEvaluator = { checkDateAvailability: jest.fn() };
    await expect(svc.scheduleAudit('asn-7', 'ops-1', '2026-10-09')).rejects.toThrow(/cannot be rescheduled/);
    expect(svc.constraintEvaluator.checkDateAvailability).not.toHaveBeenCalled();
  });
});
