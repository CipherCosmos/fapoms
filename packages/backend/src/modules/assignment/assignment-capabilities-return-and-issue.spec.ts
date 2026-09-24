import { AssayerStatus, AssignmentAction, AssignmentStatus, gateFor } from '@fapoms/shared';
import {
  buildAssignmentCapabilities,
  evaluateReportIssue,
  evaluateSubmitReturn,
  evaluateSubmitReturnForAssayer,
  type CapabilityContext,
} from './assignment-capabilities';
import { AssignmentStateMachine } from './assignment.state-machine';
import { AssignmentEntity } from './assignment.entity';

/**
 * SUBMIT_RETURN and REPORT_ISSUE as the field app is told about them.
 *
 * The upload route stores a return whatever the attendance record says, then asks completion to
 * close the job with NO reason (`DocumentController.completeAssignmentForReturn`). Completion
 * refuses when there is no check-in, or a check-in with no check-out (`completeAudit`). So the
 * capability must not offer an upload as the way to finish a job it cannot finish.
 */
const ACTIVE = { id: 'assayer-1', status: AssayerStatus.ACTIVE, isActive: true, lifecycleStatus: 'ACTIVE' };
const ctx = (): CapabilityContext => ({
  callerAssayerId: 'assayer-1',
  assayer: ACTIVE,
  complianceBlockers: [],
  now: new Date('2026-09-24T06:00:00Z'),
  dayRuleSuspended: false,
  geofenceMeters: 500,
});
const job = (over: any = {}) => ({ id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.ACCEPTED, assayerId: 'assayer-1', ...over });
const arrived = new Date('2026-09-24T04:00:00Z');
const left = new Date('2026-09-24T05:00:00Z');

describe('SUBMIT_RETURN capability', () => {
  it('checked in and not checked out → refused with "Check out first"', () => {
    const gate = evaluateSubmitReturnForAssayer(job({ status: AssignmentStatus.CHECKED_IN, checkedInAt: arrived }));
    expect(gate).toMatchObject({ allowed: false, code: 'NOT_CHECKED_OUT' });
    expect(gate.reason).toMatch(/^Check out first/);
  });

  it('agrees with completion: the same record is refused by completeAudit without a reason', () => {
    const a = { status: AssignmentStatus.CHECKED_IN, checkedInAt: arrived, checkedOutAt: null } as AssignmentEntity;
    expect(() => AssignmentStateMachine.completeAudit(a, 'assayer-1')).toThrow();
  });

  it('no check-in (e.g. reopened after an unattended completion) → refused, the office completes it', () => {
    // A reopen with no arrival returns the job to ACCEPTED with checkedInAt null (state machine).
    const gate = evaluateSubmitReturnForAssayer(job({ status: AssignmentStatus.ACCEPTED, checkedInAt: null }));
    expect(gate).toMatchObject({ allowed: false, code: 'COMPLETION_BY_OFFICE' });
    expect(gate.reason).toContain('the office completes it');
  });

  it('checked in and out → allowed', () => {
    expect(evaluateSubmitReturnForAssayer(job({ status: AssignmentStatus.CHECKED_IN, checkedInAt: arrived, checkedOutAt: left })).allowed)
      .toBe(true);
  });

  it('the route gate is unchanged — an upload is still accepted on an open job (completion refusal is reported, not thrown)', () => {
    expect(evaluateSubmitReturn(job({ status: AssignmentStatus.CHECKED_IN })).allowed).toBe(true);
    expect(evaluateSubmitReturn(job({ status: AssignmentStatus.ACCEPTED })).allowed).toBe(true);
  });

  it('buildAssignmentCapabilities sends the guided gate', () => {
    const caps = buildAssignmentCapabilities(job({ status: AssignmentStatus.CHECKED_IN, checkedInAt: arrived }), ctx());
    expect(gateFor(caps.actions, AssignmentAction.SUBMIT_RETURN)).toMatchObject({ allowed: false, code: 'NOT_CHECKED_OUT' });
  });
});

describe('REPORT_ISSUE refuses every terminal status', () => {
  it('COMPLETED keeps its original code and wording', () => {
    expect(evaluateReportIssue({ status: AssignmentStatus.COMPLETED }))
      .toMatchObject({ allowed: false, code: 'ASSIGNMENT_COMPLETED', reason: 'This assignment is already completed.' });
  });

  it.each([AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED])('%s → refused as ASSIGNMENT_CLOSED', (status) => {
    const gate = evaluateReportIssue({ status });
    expect(gate).toMatchObject({ allowed: false, code: 'ASSIGNMENT_CLOSED' });
    expect(gate.reason).toContain(String(status).toLowerCase());
  });

  it.each([AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS])(
    '%s → allowed', (status) => {
      expect(evaluateReportIssue({ status }).allowed).toBe(true);
    },
  );
});
