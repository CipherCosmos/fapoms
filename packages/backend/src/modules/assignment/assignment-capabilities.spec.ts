import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AssayerPayableStatus,
  AssayerStatus,
  AssignmentAction,
  AssignmentStatus,
  ASSIGNMENT_TRANSITIONS,
  businessDateKey,
  gateFor,
} from '@fapoms/shared';
import {
  buildAssignmentCapabilities,
  evaluateAcceptOffer,
  evaluateCheckInDay,
  evaluateCheckInPosition,
  evaluateCheckOut,
  evaluateDeclineOffer,
  evaluateExpenseClaim,
  evaluateFieldWorkStanding,
  evaluateOwnership,
  evaluateReportIssue,
  evaluateSubmitReturn,
  relevantActions,
  type CapabilityContext,
} from './assignment-capabilities';
import { AssignmentStateMachine } from './assignment.state-machine';
import { AssignmentService } from './assignment.service';

/**
 * The field app draws its buttons from `capabilities`, built by these evaluators — and the routes
 * refuse with the same evaluators. These tests pin both halves of that promise: each evaluator's
 * verdicts (with the route's exact sentences and codes), and that the routes really call them.
 */

const ACTIVE = { id: 'assayer-1', assayerCode: 'AS-01', displayName: 'Asha', status: AssayerStatus.ACTIVE, isActive: true, lifecycleStatus: 'ACTIVE' };
const BRANCH = { latitude: '12.9716', longitude: '77.5946', geoAccuracyMeters: 0 };
const job = (over: any = {}) => ({ id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.ACCEPTED, assayerId: 'assayer-1', branch: BRANCH, ...over });
const ctx = (over: Partial<CapabilityContext> = {}): CapabilityContext => ({
  callerAssayerId: 'assayer-1',
  assayer: ACTIVE,
  complianceBlockers: [],
  now: new Date(),
  dayRuleSuspended: false,
  geofenceMeters: 2000,
  feePayable: null,
  ...over,
});

describe('the transition table has one home', () => {
  it('the backend state machine enforces the shared table itself, not a copy', () => {
    expect((AssignmentStateMachine as any).VALID_PATHS).toBe(ASSIGNMENT_TRANSITIONS);
  });

  it('the assayer-requestable transitions are read from shared by the controller', () => {
    const src = readFileSync(join(__dirname, 'assignment.controller.ts'), 'utf8');
    expect(src).toContain('ASSAYER_REQUESTABLE_ASSIGNMENT_TRANSITIONS');
    expect(src).not.toMatch(/const ASSAYER_TRANSITIONS\s*=/);
  });
});

describe('ownership', () => {
  it('refuses somebody else\'s assignment, and a missing one', () => {
    expect(evaluateOwnership(AssignmentAction.ACCEPT, { assayerId: 'x' }, 'assayer-1')).toMatchObject({ allowed: false, code: 'NOT_YOUR_ASSIGNMENT' });
    expect(evaluateOwnership(AssignmentAction.ACCEPT, null, 'assayer-1').allowed).toBe(false);
    expect(evaluateOwnership(AssignmentAction.ACCEPT, { assayerId: 'assayer-1' }, 'assayer-1').allowed).toBe(true);
  });
});

describe('accept / decline', () => {
  it('keeps the route\'s order and wording: standing, then compliance, then the table', () => {
    const suspended = { ...ACTIVE, status: AssayerStatus.SUSPENDED };
    expect(evaluateAcceptOffer({ status: AssignmentStatus.CANCELLED }, suspended, ['x'])).toEqual({
      action: 'ACCEPT', allowed: false, code: 'ASSAYER_NOT_ACTIVE',
      reason: "Assayer AS-01 is 'SUSPENDED' and cannot accept assignments.",
    });
    expect(evaluateAcceptOffer({ status: AssignmentStatus.CANCELLED }, ACTIVE, ['Police check overdue'])).toMatchObject({
      code: 'ASSAYER_COMPLIANCE_BLOCKED',
      reason: 'Asha cannot be given new work: Police check overdue. Record it on their Background tab.',
    });
    expect(evaluateAcceptOffer({ status: AssignmentStatus.CANCELLED }, ACTIVE, [])).toMatchObject({
      code: 'INVALID_ASSIGNMENT_TRANSITION',
      reason: "Invalid transition path from 'CANCELLED' to 'ACCEPTED'",
    });
    expect(evaluateAcceptOffer({ status: AssignmentStatus.PENDING }, ACTIVE, []).allowed).toBe(true);
  });

  it('judges no standing when the assayer row was not found — as the route never did', () => {
    expect(evaluateAcceptOffer({ status: AssignmentStatus.PENDING }, null, []).allowed).toBe(true);
  });

  it('speaks to the assayer, with the same code, when asked for the assayer', () => {
    const gate = evaluateAcceptOffer({ status: AssignmentStatus.PENDING }, ACTIVE, ['Police check overdue'], 'assayer');
    expect(gate.code).toBe('ASSAYER_COMPLIANCE_BLOCKED');
    expect(gate.reason).toMatch(/^You cannot take on new work/);
  });

  it('declines only what the table lets move to REJECTED', () => {
    expect(evaluateDeclineOffer({ status: AssignmentStatus.PENDING }).allowed).toBe(true);
    expect(evaluateDeclineOffer({ status: AssignmentStatus.ACCEPTED })).toMatchObject({ allowed: false, code: 'INVALID_ASSIGNMENT_TRANSITION' });
  });

  it('the state machine\'s own refusal carries the same code', () => {
    const a: any = { status: AssignmentStatus.CANCELLED };
    try {
      AssignmentStateMachine.acceptOffer(a, 'u');
      fail('expected a refusal');
    } catch (err: any) {
      expect(err.getResponse()).toMatchObject({ code: 'INVALID_ASSIGNMENT_TRANSITION' });
      expect(err.message).toBe("Invalid transition path from 'CANCELLED' to 'ACCEPTED'");
    }
  });
});

describe('check-in without a fix', () => {
  it('refuses a suspended or missing assayer with the route\'s sentence', () => {
    expect(evaluateFieldWorkStanding({ ...ACTIVE, status: AssayerStatus.SUSPENDED, lifecycleStatus: 'SUSPENDED' })).toMatchObject({
      code: 'ASSAYER_NOT_ACTIVE',
      reason: 'Check-in refused: Assayer is currently SUSPENDED. Suspended or inactive assayers cannot start new field work.',
    });
    expect(evaluateFieldWorkStanding(null).allowed).toBe(false);
  });

  it('says when check-in opens for a future day, and only then', () => {
    const now = new Date('2026-09-24T10:00:00+05:30');
    const early = evaluateCheckInDay('2026-09-26', now, false);
    expect(early).toMatchObject({ allowed: false, code: 'NOT_SCHEDULED_TODAY' });
    expect(early.opensAt).toBe(new Date('2026-09-26T00:00:00+05:30').toISOString());
    expect(early.reason).toContain('Check-in opens on the day itself');

    const late = evaluateCheckInDay('2026-09-20', now, false);
    expect(late).toMatchObject({ allowed: false, code: 'NOT_SCHEDULED_TODAY' });
    expect(late.opensAt).toBeUndefined();

    expect(evaluateCheckInDay('2026-09-24', now, false).allowed).toBe(true);
    expect(evaluateCheckInDay(null, now, false).allowed).toBe(true);
  });

  it('honours an administrator\'s bypass of the day rule and reports the mismatch for the audit', () => {
    const now = new Date('2026-09-24T10:00:00+05:30');
    const gate = evaluateCheckInDay('2026-09-26', now, true);
    expect(gate.allowed).toBe(true);
    expect(gate.mismatch).toEqual({ today: '2026-09-24', scheduled: '2026-09-26' });
  });

  it('reads the IST day, not the UTC one (00:30 IST is still the previous day in UTC)', () => {
    const justAfterMidnightIst = new Date('2026-09-24T00:30:00+05:30');
    expect(evaluateCheckInDay('2026-09-24', justAfterMidnightIst, false).allowed).toBe(true);
  });
});

describe('the geofence, route-side', () => {
  it('passes inside the zone and refuses far away with the route\'s sentence', () => {
    expect(evaluateCheckInPosition({ fix: { latitude: 12.9716, longitude: 77.5946 }, branch: BRANCH, geofenceMeters: 2000 }).allowed).toBe(true);
    const far = evaluateCheckInPosition({ fix: { latitude: 28.6315, longitude: 77.2167 }, branch: BRANCH, geofenceMeters: 2000 });
    expect(far).toMatchObject({ allowed: false, code: 'TOO_FAR_FROM_BRANCH' });
    expect(far.reason).toMatch(/^You appear to be \d+\.\d km from this branch\. Check-in works only at the branch itself/);
  });

  it('adds the device accuracy (capped) and the branch pin accuracy to the zone', () => {
    const point = { latitude: 12.9716, longitude: 77.6194 }; // ~2.7 km east
    expect(evaluateCheckInPosition({ fix: point, deviceAccuracyMeters: 1000, branch: BRANCH, geofenceMeters: 2000 }).allowed).toBe(true);
    expect(evaluateCheckInPosition({ fix: point, deviceAccuracyMeters: 10, branch: BRANCH, geofenceMeters: 2000 }).allowed).toBe(false);
    expect(evaluateCheckInPosition({ fix: point, deviceAccuracyMeters: 10, branch: { ...BRANCH, geoAccuracyMeters: 1000 }, geofenceMeters: 2000 }).allowed).toBe(true);
  });

  it('does not measure against a branch with no pin', () => {
    const g = evaluateCheckInPosition({ fix: { latitude: 28.6, longitude: 77.2 }, branch: { latitude: null, longitude: null }, geofenceMeters: 2000 });
    expect(g).toMatchObject({ allowed: true, distanceMeters: null });
  });
});

describe('check-out, return, expense, issue', () => {
  it('check-out needs an arrival and a live job', () => {
    expect(evaluateCheckOut({ status: AssignmentStatus.ACCEPTED, checkedInAt: null }).code).toBe('NOT_CHECKED_IN');
    expect(evaluateCheckOut({ status: AssignmentStatus.CANCELLED, checkedInAt: new Date() }).code).toBe('ASSIGNMENT_CANCELLED');
    expect(evaluateCheckOut({ status: AssignmentStatus.CHECKED_IN, checkedInAt: new Date() }).allowed).toBe(true);
  });

  it('a finished job takes no more paperwork, in the route\'s words', () => {
    expect(evaluateSubmitReturn({ id: 'a', assignmentNumber: 'ASN-9', status: AssignmentStatus.COMPLETED })).toMatchObject({
      code: 'ASSIGNMENT_CLOSED',
      reason: 'Assignment ASN-9 is already completed, so no more paperwork can be added to it. If its return needs replacing, ask operations to reopen it.',
    });
    expect(evaluateSubmitReturn({ id: 'a', status: AssignmentStatus.CHECKED_IN }).allowed).toBe(true);
  });

  it('expense: visit under way, and the pay not yet on a bill, approved or paid', () => {
    expect(evaluateExpenseClaim({ status: AssignmentStatus.ACCEPTED }, null).code).toBe('EXPENSE_VISIT_NOT_STARTED');
    expect(evaluateExpenseClaim({ status: AssignmentStatus.CHECKED_IN }, null).allowed).toBe(true);
    expect(evaluateExpenseClaim({ status: AssignmentStatus.COMPLETED }, { status: AssayerPayableStatus.PENDING, assayerInvoiceId: 'inv' }).code)
      .toBe('EXPENSE_JOB_ALREADY_BILLED');
    expect(evaluateExpenseClaim({ status: AssignmentStatus.COMPLETED }, { status: AssayerPayableStatus.PAID }).reason)
      .toBe('The pay for this job has already been paid. Claims must be made before billing.');
    // A voided payable from an earlier completion is history and never blocks.
    expect(evaluateExpenseClaim({ status: AssignmentStatus.COMPLETED }, { status: AssayerPayableStatus.VOIDED, assayerInvoiceId: 'inv' }).allowed).toBe(true);
  });

  it('an issue may not be reported on a completed job', () => {
    expect(evaluateReportIssue({ status: AssignmentStatus.COMPLETED })).toMatchObject({ code: 'ASSIGNMENT_COMPLETED', reason: 'This assignment is already completed.' });
    expect(evaluateReportIssue({ status: AssignmentStatus.PENDING }).allowed).toBe(true);
  });
});

describe('which actions a job lists', () => {
  it.each([
    [AssignmentStatus.PENDING, {}, ['ACCEPT', 'DECLINE', 'REPORT_ISSUE']],
    [AssignmentStatus.ACCEPTED, {}, ['CHECK_IN', 'SUBMIT_RETURN', 'CLAIM_EXPENSE', 'REPORT_ISSUE']],
    [AssignmentStatus.CHECKED_IN, { checkedInAt: new Date() }, ['CHECK_OUT', 'SUBMIT_RETURN', 'CLAIM_EXPENSE', 'REPORT_ISSUE']],
    [AssignmentStatus.IN_PROGRESS, { checkedInAt: new Date(), checkedOutAt: new Date() }, ['SUBMIT_RETURN', 'CLAIM_EXPENSE', 'REPORT_ISSUE']],
    [AssignmentStatus.COMPLETED, {}, ['CLAIM_EXPENSE']],
    [AssignmentStatus.REJECTED, {}, []],
    [AssignmentStatus.CANCELLED, {}, []],
  ])('%s', (status, over, expected) => {
    expect(relevantActions({ status, ...(over as any) })).toEqual(expected);
  });
});

describe('buildAssignmentCapabilities', () => {
  it('an open offer from a held assayer: accept disabled with the reason, decline allowed', () => {
    const caps = buildAssignmentCapabilities(job({ status: AssignmentStatus.PENDING }), ctx({ complianceBlockers: ['BGV re-check overdue'] }));
    expect(gateFor(caps.actions, AssignmentAction.ACCEPT)).toMatchObject({ allowed: false, code: 'ASSAYER_COMPLIANCE_BLOCKED' });
    expect(gateFor(caps.actions, AssignmentAction.DECLINE).allowed).toBe(true);
    expect(caps.checkInZone).toBeNull();
  });

  it('an accepted job for a future day: check-in closed until the day, with opensAt, and the zone attached', () => {
    const now = new Date('2026-09-24T10:00:00+05:30');
    const caps = buildAssignmentCapabilities(job({ scheduledDate: '2026-09-25' }), ctx({ now }));
    const checkIn = gateFor(caps.actions, AssignmentAction.CHECK_IN);
    expect(checkIn).toMatchObject({ allowed: false, code: 'NOT_SCHEDULED_TODAY', opensAt: '2026-09-24T18:30:00.000Z' });
    expect(Object.keys(checkIn).sort()).toEqual(['action', 'allowed', 'code', 'opensAt', 'reason']);
    expect(caps.checkInZone).toEqual({ latitude: 12.9716, longitude: 77.5946, radiusMeters: 2000 });
  });

  it('sends the smaller arrival circle beside the zone, never larger than the zone', () => {
    const now = new Date();
    const today = businessDateKey(now);
    expect(buildAssignmentCapabilities(job({ scheduledDate: today }), ctx({ now, arrivalRadiusMeters: 200 })).checkInZone)
      .toEqual({ latitude: 12.9716, longitude: 77.5946, radiusMeters: 2000, arrivalRadiusMeters: 200 });
    expect(buildAssignmentCapabilities(job({ scheduledDate: today }), ctx({ now, arrivalRadiusMeters: 5000 })).checkInZone?.arrivalRadiusMeters)
      .toBe(2000);
  });

  it('an accepted job for today: check-in allowed', () => {
    const now = new Date();
    const caps = buildAssignmentCapabilities(job({ scheduledDate: businessDateKey(now) }), ctx({ now }));
    expect(gateFor(caps.actions, AssignmentAction.CHECK_IN)).toEqual({ action: 'CHECK_IN', allowed: true });
  });

  it('a job belonging to somebody else refuses everything it lists', () => {
    const caps = buildAssignmentCapabilities(job(), ctx({ callerAssayerId: 'someone-else' }));
    expect(caps.actions.every((g) => !g.allowed && g.code === 'NOT_YOUR_ASSIGNMENT')).toBe(true);
  });

  it('a completed job whose pay is already on a bill: claim disabled', () => {
    const caps = buildAssignmentCapabilities(job({ status: AssignmentStatus.COMPLETED }), ctx({
      feePayable: { status: AssayerPayableStatus.PENDING, assayerInvoiceId: 'inv-1' },
    }));
    expect(caps.actions).toEqual([expect.objectContaining({ action: 'CLAIM_EXPENSE', allowed: false, code: 'EXPENSE_JOB_ALREADY_BILLED' })]);
  });
});

describe('the routes call the evaluators (single source)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
  it.each([
    ['assignment.service.ts', ['evaluateAcceptOffer(', 'evaluateDeclineOffer(', 'evaluateCheckInState(', 'evaluateFieldWorkStanding(', 'evaluateCheckInDay(', 'evaluateCheckInPosition(', 'evaluateCheckOut(', 'evaluateReportIssue(']],
    ['../document/document.controller.ts', ['evaluateSubmitReturn(', 'evaluateOwnership(']],
    ['../expense/expense.service.ts', ['evaluateExpenseClaim(']],
    ['assignment.controller.ts', ['evaluateOwnership(']],
  ])('%s', (file, calls) => {
    const src = read(file);
    for (const call of calls) expect(src).toContain(call);
  });
});

describe('the work list computes capabilities without N+1 reads', () => {
  it('reads the assayer, compliance, payables, the geofence and the bypass once each for a whole list', async () => {
    const assayerFind = jest.fn().mockResolvedValue(ACTIVE);
    const service: any = Object.create(AssignmentService.prototype);
    service.dataSource = { getRepository: jest.fn(() => ({ findOne: assayerFind })) };
    service.compliance = { workBlockers: jest.fn().mockResolvedValue([]) };
    service.billingEngine = { liveFeePayables: jest.fn().mockResolvedValue(new Map()) };
    service.settings = { getMany: jest.fn().mockResolvedValue({ 'field.checkInGeofenceMeters': 2000, 'field.arrivalRadiusMeters': 150 }) };
    service.ruleBypass = { isBypassed: jest.fn().mockResolvedValue(false) };

    const rows: any[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push({
        id: `a-${i}`,
        assignmentNumber: `ASN-${i}`,
        assayerId: 'assayer-1',
        status: [AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.COMPLETED][i % 4],
        checkedInAt: i % 4 === 2 ? new Date() : null,
        scheduledDate: '2020-01-01',
        projectBranch: { branch: BRANCH },
      });
    }
    await service.attachCapabilities(rows, 'assayer-1');

    expect(assayerFind).toHaveBeenCalledTimes(1);
    expect(service.compliance.workBlockers).toHaveBeenCalledTimes(1);
    expect(service.billingEngine.liveFeePayables).toHaveBeenCalledTimes(1);
    expect(service.settings.getMany).toHaveBeenCalledTimes(1);
    const accepted = rows.find((r) => r.status === AssignmentStatus.ACCEPTED);
    expect(accepted.capabilities.checkInZone).toMatchObject({ radiusMeters: 2000, arrivalRadiusMeters: 150 });
    expect(service.ruleBypass.isBypassed).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => Array.isArray(r.capabilities?.actions))).toBe(true);
  });

  it('skips the reads nothing on the list needs', async () => {
    const service: any = Object.create(AssignmentService.prototype);
    service.dataSource = { getRepository: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(ACTIVE) })) };
    service.compliance = { workBlockers: jest.fn() };
    service.billingEngine = { liveFeePayables: jest.fn() };
    service.settings = { getMany: jest.fn() };
    service.ruleBypass = { isBypassed: jest.fn() };
    const rows: any[] = [{ id: 'r', assayerId: 'assayer-1', status: AssignmentStatus.REJECTED, projectBranch: { branch: BRANCH } }];
    await service.attachCapabilities(rows, 'assayer-1');
    expect(service.compliance.workBlockers).not.toHaveBeenCalled();
    expect(service.billingEngine.liveFeePayables).not.toHaveBeenCalled();
    expect(service.settings.getMany).not.toHaveBeenCalled();
    expect(service.ruleBypass.isBypassed).not.toHaveBeenCalled();
    expect(rows[0].capabilities).toEqual({ actions: [], checkInZone: null });
  });
});
