import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AssayerStatus,
  AssignmentAction,
  AssignmentStatus,
  ASSIGNMENT_TRANSITIONS,
  REASSIGNABLE_ASSIGNMENT_STATUSES,
  ScheduleStatus,
  canTransitionAssignment,
} from '@fapoms/shared';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';
import { AssignmentStateMachine } from './assignment.state-machine';
import { DAY_TRAVEL_QUERY_MARKER, dayTravelAlreadyCharged } from './assignment-day-travel';
import { buildAssignmentCapabilities, evaluateAcceptOffer, leaveCovering } from './assignment-capabilities';
import { NOTIFICATION_CATALOG, renderTemplate } from '../notifications/notification-catalog';
import { SchedulingService } from '../scheduling/scheduling.service';
import { AssayerService } from '../assayer/assayer.service';

/**
 * Owner decisions of 2026-09-24 that are not pinned beside an existing suite:
 *
 *  E2  several branches per assayer per day; travel charged once per assayer per day
 *  E8  a job dated inside the assayer's leave cannot be accepted (the capabilities gate says so)
 *  E9  reassign from Planning until check-in, through the transition table
 *  6   completion notices (catalog wording; the sending is pinned in assignment.service.spec.ts)
 *  7   E11: schedule dispatch / reschedule notices are keyed per occurrence
 *
 * E6 (reopen = papers only) lives in assignment-reopen.spec.ts, E12 (office check-in) and the
 * service-level E8/E9/completion/date-change cases in assignment.service.spec.ts.
 */

const codeOf = (e: any) => e?.getResponse?.()?.code ?? e?.code;

// ── E2: travel once per assayer per day ────────────────────────────────────────────────────────

describe('E2 — travel is charged once per assayer per day', () => {
  it('asks for another live job of this assayer on this business day that already carries travel', async () => {
    const query = jest.fn(async () => [{ id: 'asn-morning' }]);
    await expect(dayTravelAlreadyCharged({ query }, 'as-1', '2026-10-05T10:00:00+05:30', 'asn-self')).resolves.toBe(true);

    const [sql, params] = (query.mock.calls as any[])[0];
    expect(params).toEqual(['as-1', '2026-10-05', 'asn-self']);
    expect(sql).toContain(DAY_TRAVEL_QUERY_MARKER);
    // Live work only: an offer, accepted, on site or completed — never a declined or cancelled one.
    for (const s of ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) expect(sql).toContain(`'${s}'`);
    for (const s of ['REJECTED', 'CANCELLED']) expect(sql).not.toContain(`'${s}'`);
    // The job being priced never counts against itself.
    expect(sql).toMatch(/id <> \$3/);
  });

  it('answers no when nothing else that day carries travel', async () => {
    await expect(dayTravelAlreadyCharged({ query: jest.fn(async () => []) }, 'as-1', new Date('2026-10-05'), null)).resolves.toBe(false);
  });

  it('is asked inside the create transaction, after the assayer row is locked', () => {
    const source = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');
    const createAt = source.indexOf('  async create(');
    const lockAt = source.indexOf("'SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [dto.assayerId]", createAt);
    const askAt = source.indexOf('await dayTravelAlreadyCharged(manager, dto.assayerId', createAt);
    expect(lockAt).toBeGreaterThan(createAt);
    expect(askAt).toBeGreaterThan(lockAt);
  });

  /** Reassigning to somebody who already travels that day prices the job base-only for them. */
  describe('on reassignment', () => {
    const makeReassign = (travelAlreadyCharged: boolean) => {
      const saved: any[] = [];
      const row: any = {
        id: 'asn-1', assayerId: 'as-old', status: AssignmentStatus.ACCEPTED, projectBranchId: 'pb-1',
        assayer: { id: 'as-old', displayName: 'Old' },
        projectBranch: { id: 'pb-1', status: 'ASSIGNMENT_CONFIRMED', branch: { name: 'Kochi' } },
        scheduledDate: '2026-10-05', entityVersion: 1,
      };
      const manager: any = {
        query: jest.fn(async (sql: string) => {
          if (/FROM assignments WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ status: row.status, assayer_id: 'as-old', entity_version: 1 }];
          if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) return [{ assayer_id: 'as-new', entity_version: 2, status: 'PENDING' }];
          if (sql.includes(DAY_TRAVEL_QUERY_MARKER)) return travelAlreadyCharged ? [{ id: 'asn-morning' }] : [];
          return [];
        }),
        findOne: jest.fn(async (target: any) => (target === AssignmentEntity ? row : target === AssignmentReassignmentEntity ? null : null)),
        create: jest.fn((_c: any, dto: any) => ({ id: 'lin-1', ...dto })),
        getRepository: jest.fn(() => ({ findOne: jest.fn(async () => null), save: jest.fn(async (x: any) => x) })),
        save: jest.fn(async (e: any) => { if (e?.previousAssayerId === undefined) saved.push({ ...e }); return e; }),
      };
      const svc: any = Object.create(AssignmentService.prototype);
      svc.uow = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
      svc.assignmentRepository = { manager: { query: jest.fn(async () => []) }, findOne: jest.fn(async () => row) };
      svc.repriceForAssayer = jest.fn(async () => ({
        total: 1500, baseFee: 1200, travelFee: 300, distanceKm: 40, distanceSource: 'OSRM', transportMode: 'BUS',
        baseOnly: { total: 1200, baseFee: 1200, travelFee: 0 },
      }));
      svc.auditService = { recordEventSafe: jest.fn() };
      svc.assayerService = {
        findOne: jest.fn(async () => ({ id: 'as-new', status: AssayerStatus.ACTIVE, isActive: true, displayName: 'New', assayerCode: 'AS-N' })),
        disableLiveTrackingWhenWorkEnds: jest.fn(),
      };
      svc.targetEligibility = { evaluate: jest.fn(async () => ({ outcome: 'ALLOWED', standing: 'ACTIVE', empanelmentId: null, empanelmentEffectiveAt: null })), resolveBlock: jest.fn() };
      svc.ruleBypass = { isBypassedSync: () => false, noteBypass: jest.fn() };
      svc.notificationDispatch = { emitSafe: jest.fn() };
      svc.projectService = { initiateBranchPlanning: jest.fn() };
      return { svc: svc as AssignmentService, saved };
    };

    it('charges the new assayer travel when the day is otherwise theirs to travel', async () => {
      const { svc, saved } = makeReassign(false);
      await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'nearer assayer');
      expect(saved[0]).toMatchObject({ proposedFee: 1500, agreedFee: 1500, quotedTravelFee: 300, quotedTransportMode: 'BUS' });
    });

    it('prices base-only when another of the new assayer\'s jobs that day already carries the journey', async () => {
      const { svc, saved } = makeReassign(true);
      await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'nearer assayer');
      expect(saved[0]).toMatchObject({ proposedFee: 1200, agreedFee: 1200, quotedTravelFee: 0, quotedTransportMode: null });
      expect(saved[0].quotedDistanceKm).toBe(40);
    });
  });
});

// ── Item 5: reassign + desk fee + desk confirmation in ONE transaction ─────────────────────────

describe('reassign is atomic with the desk\'s fee, date and confirmation', () => {
  const make = (opts: { failIn?: 'branch' } = {}) => {
    const saved: any[] = [];
    const audits: any[] = [];
    const row: any = {
      id: 'asn-1', assignmentNumber: 'ASN-1', assayerId: 'as-old', status: AssignmentStatus.PENDING, projectBranchId: 'pb-1',
      assayer: { id: 'as-old', displayName: 'Old' }, autoSchedule: true,
      projectBranch: { id: 'pb-1', status: 'PLANNING', branch: { name: 'Kochi', state: 'KL' }, project: { clientId: null } },
      scheduledDate: '2026-10-05', entityVersion: 1,
    };
    const pbSaves: any[] = [];
    const manager: any = {
      query: jest.fn(async (sql: string) => {
        if (/FROM assignments WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ status: row.status, assayer_id: 'as-old', entity_version: 1 }];
        if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) {
          const last = saved[saved.length - 1];
          return [{ assayer_id: 'as-new', entity_version: 2, status: last?.status ?? 'PENDING' }];
        }
        return [];
      }),
      findOne: jest.fn(async (target: any) => (target === AssignmentEntity ? row : null)),
      create: jest.fn((_c: any, dto: any) => ({ id: 'lin-1', ...dto })),
      getRepository: jest.fn((target: any) => ({
        findOne: jest.fn(async () => (target?.name === 'ProjectBranchEntity' ? { id: 'pb-1', status: 'PLANNING', isActive: true } : null)),
        save: jest.fn(async (x: any) => {
          if (target?.name === 'ProjectBranchEntity') {
            if (opts.failIn === 'branch') throw new Error('branch write failed');
            pbSaves.push({ ...x });
          }
          return x;
        }),
      })),
      save: jest.fn(async (e: any) => { if (e?.previousAssayerId === undefined) saved.push({ ...e }); return e; }),
    };
    const emits: any[] = [];
    const svc: any = Object.create(AssignmentService.prototype);
    svc.uow = { run: jest.fn(async (work: any) => work(manager, (ev: string, p: any) => emits.push({ ev, p }))) };
    svc.assignmentRepository = { manager: { query: jest.fn(async () => []) }, findOne: jest.fn(async () => ({ ...row, projectBranch: { ...row.projectBranch } })) };
    svc.repriceForAssayer = jest.fn(async () => ({
      total: 1500, baseFee: 1200, travelFee: 300, distanceKm: 40, distanceSource: 'OSRM', transportMode: 'BUS', baseOnly: null,
    }));
    svc.auditService = { recordEventSafe: jest.fn(async (e: any) => { audits.push(e); }) };
    svc.assayerService = {
      findOne: jest.fn(async () => ({ id: 'as-new', status: AssayerStatus.ACTIVE, isActive: true, displayName: 'New', assayerCode: 'AS-N', leaves: [] })),
      disableLiveTrackingWhenWorkEnds: jest.fn(),
      enableLiveTrackingForActiveWork: jest.fn(),
    };
    svc.targetEligibility = { evaluate: jest.fn(), resolveBlock: jest.fn() };
    svc.ruleBypass = { isBypassed: jest.fn(async () => false), noteBypass: jest.fn() };
    svc.notificationDispatch = { emitSafe: jest.fn() };
    svc.projectService = { initiateBranchPlanning: jest.fn() };
    svc.constraintEvaluator = { checkDateAvailability: jest.fn(async () => ({ passed: true })) };
    svc.autoScheduleOnAcceptance = jest.fn(async () => ({ scheduleId: 'sch-1', scheduledDate: '2026-10-05' }));
    svc.dayTravel = { rebalanceMany: jest.fn(async () => undefined) };
    return { svc: svc as AssignmentService, raw: svc, saved, audits, emits, pbSaves, manager };
  };
  const types = (raw: any) => raw.notificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);

  it('moves, records the desk\'s fee on both columns and accepts — one transaction, one row version', async () => {
    const { svc, raw, saved, audits, pbSaves } = make();
    await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'nearer assayer', { proposedFee: 1700, acceptOnBehalf: true });
    expect(raw.uow.run).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ assayerId: 'as-new', status: AssignmentStatus.ACCEPTED, proposedFee: 1700, agreedFee: 1700, entityVersion: 2 });
    expect(audits.map((a) => a.eventType)).toEqual(expect.arrayContaining(['ASSIGNMENT_REASSIGNED', 'ASSIGNMENT_ACCEPTED']));
    // The branch is confirmed, not sent back to planning; the calendar row is revived for them.
    expect(pbSaves[0]).toMatchObject({ status: 'ASSIGNMENT_CONFIRMED' });
    expect(raw.projectService.initiateBranchPlanning).not.toHaveBeenCalled();
    expect(raw.autoScheduleOnAcceptance).toHaveBeenCalled();
    // Told as a desk confirmation, never as an offer to accept.
    expect(types(raw)).toEqual(expect.arrayContaining(['ASSIGNMENT_REASSIGNED_AWAY', 'ASSIGNMENT_DESK_CONFIRMED', 'SCHEDULE_DISPATCHED', 'ASSIGNMENT_REASSIGNED']));
    expect(types(raw)).not.toContain('ASSIGNMENT_OFFERED');
    expect(raw.assayerService.enableLiveTrackingForActiveWork).toHaveBeenCalledWith('as-new', 'ops-1');
  });

  it('a fee over twice the new assayer\'s quote is refused before anything moves', async () => {
    const { svc, raw } = make();
    await expect(svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r', { proposedFee: 3001, acceptOnBehalf: true })).rejects.toThrow(/exceeds twice/);
    expect(raw.uow.run).not.toHaveBeenCalled();
    expect(raw.notificationDispatch.emitSafe).not.toHaveBeenCalled();
  });

  it('an incoming assayer on leave that day cannot be desk-confirmed — refused before anything moves', async () => {
    const { svc, raw } = make();
    raw.assayerService.findOne = jest.fn(async () => ({ id: 'as-new', status: AssayerStatus.ACTIVE, isActive: true, displayName: 'New', assayerCode: 'AS-N', leaves: [{ startDate: '2026-10-04', endDate: '2026-10-06' }] }));
    const err: any = await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r', { acceptOnBehalf: true }).catch((e) => e);
    expect(err?.getResponse?.()?.code).toBe('ASSAYER_ON_LEAVE');
    expect(raw.uow.run).not.toHaveBeenCalled();
  });

  it('a new date that cannot be worked is refused before anything moves', async () => {
    const { svc, raw } = make();
    raw.constraintEvaluator.checkDateAvailability = jest.fn(async () => ({ passed: false, reason: 'Holiday Conflict: 2026-10-02' }));
    await expect(svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r', { scheduledDate: '2026-10-02' })).rejects.toThrow(/Holiday Conflict/);
    expect(raw.uow.run).not.toHaveBeenCalled();
  });

  it('a failure inside the transaction rolls the whole thing back — nobody is told anything', async () => {
    const { svc, raw } = make({ failIn: 'branch' });
    await expect(svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r', { acceptOnBehalf: true })).rejects.toThrow(/branch write failed/);
    expect(raw.notificationDispatch.emitSafe).not.toHaveBeenCalled();
    expect(raw.dayTravel.rebalanceMany).not.toHaveBeenCalled();
  });

  it('without the extras it is the plain reassignment it always was: PENDING, re-priced, offered', async () => {
    const { svc, raw, saved } = make();
    await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r');
    expect(saved[0]).toMatchObject({ status: AssignmentStatus.PENDING, proposedFee: 1500, agreedFee: 1500 });
    expect(types(raw)).toContain('ASSIGNMENT_OFFERED');
    expect(types(raw)).not.toContain('ASSIGNMENT_DESK_CONFIRMED');
  });

  it('a new date is written in the same write, and priced for that day', async () => {
    const { svc, raw, saved } = make();
    await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r', { scheduledDate: '2026-10-09' });
    expect(saved[0].scheduledDate).toEqual(new Date('2026-10-09'));
    expect(raw.repriceForAssayer.mock.calls[0][0].scheduledDate).toEqual(new Date('2026-10-09'));
  });

  it('re-decides the outgoing assayer\'s old day and the incoming assayer\'s day after commit (item 1)', async () => {
    const { svc, raw } = make();
    await svc.reassignAssignment('asn-1', 'as-new', 'ops-1', 'r', { scheduledDate: '2026-10-09' });
    expect(raw.dayTravel.rebalanceMany).toHaveBeenCalledWith(
      [
        { assayerId: 'as-old', day: '2026-10-05' },
        { assayerId: 'as-new', day: new Date('2026-10-09'), arrivingAssignmentId: 'asn-1' },
      ],
      'ops-1',
      expect.stringContaining('reassigned'),
    );
  });
});

// ── E8: leave ──────────────────────────────────────────────────────────────────────────────────

describe('E8 — a job dated inside the assayer\'s leave cannot be accepted', () => {
  const assayer = { id: 'as-1', status: AssayerStatus.ACTIVE, isActive: true, displayName: 'Anu', leaves: [{ startDate: '2026-10-04', endDate: '2026-10-06' }] };
  const offer = (day: string) => ({ status: AssignmentStatus.PENDING, scheduledDate: day });

  it.each(['2026-10-04', '2026-10-05', '2026-10-06'])('refuses %s (both ends inclusive), with a stable code', (day) => {
    const gate = evaluateAcceptOffer(offer(day), assayer, []);
    expect(gate).toMatchObject({ allowed: false, code: 'ASSAYER_ON_LEAVE' });
  });

  it.each(['2026-10-03', '2026-10-07'])('allows %s, just outside the leave', (day) => {
    expect(evaluateAcceptOffer(offer(day), assayer, []).allowed).toBe(true);
  });

  it('judges the date the desk names over the job\'s own date', () => {
    expect(evaluateAcceptOffer(offer('2026-10-01'), assayer, [], 'desk', { onDate: '2026-10-05' }).code).toBe('ASSAYER_ON_LEAVE');
    expect(evaluateAcceptOffer(offer('2026-10-05'), assayer, [], 'desk', { onDate: '2026-10-09' }).allowed).toBe(true);
  });

  it('lets an administrator\'s ASSAYER_LEAVE bypass through', () => {
    expect(evaluateAcceptOffer(offer('2026-10-05'), assayer, [], 'desk', { leaveRuleSuspended: true }).allowed).toBe(true);
  });

  it('keeps the earlier refusals first — a declined offer says so, not "on leave"', () => {
    expect(evaluateAcceptOffer({ status: AssignmentStatus.REJECTED, scheduledDate: '2026-10-05' }, assayer, []).code)
      .toBe('INVALID_ASSIGNMENT_TRANSITION');
  });

  it('speaks to the assayer in their own voice on the phone', () => {
    const gate = evaluateAcceptOffer(offer('2026-10-05'), assayer, [], 'assayer');
    expect(gate.reason).toMatch(/^You are on leave on 2026-10-05/);
  });

  it('surfaces through the capabilities gate the field app draws from', () => {
    const caps = buildAssignmentCapabilities(
      { id: 'asn-1', status: AssignmentStatus.PENDING, assayerId: 'as-1', scheduledDate: '2026-10-05' },
      { callerAssayerId: 'as-1', assayer, complianceBlockers: [], now: new Date('2026-10-01T05:00:00Z'), dayRuleSuspended: false, geofenceMeters: 500 },
    );
    const accept = caps.actions.find((a) => a.action === AssignmentAction.ACCEPT)!;
    expect(accept).toMatchObject({ allowed: false, code: 'ASSAYER_ON_LEAVE' });
    expect(accept.reason).toBeTruthy();
    // Declining stays open — that is what somebody on leave does with such an offer.
    expect(caps.actions.find((a) => a.action === AssignmentAction.DECLINE)!.allowed).toBe(true);
  });

  it('reads leave the way the evaluator stores it', () => {
    expect(leaveCovering([{ startDate: '2026-10-04T00:00:00.000Z', endDate: '2026-10-06' }], '2026-10-06')).toEqual({ startDate: '2026-10-04', endDate: '2026-10-06' });
    expect(leaveCovering(null, '2026-10-06')).toBeNull();
    expect(leaveCovering([{ startDate: '2026-10-04', endDate: '2026-10-06' }], null)).toBeNull();
  });

  it('adding leave is still only refused over ACCEPTED-or-later work, never over a PENDING offer', async () => {
    const svc: any = Object.create(AssayerService.prototype);
    const query = jest.fn(async () => []);
    svc.dataSource = { query };
    await svc.assertLeaveClearOfCommittedWork('as-1', [], [{ startDate: '2026-10-04', endDate: '2026-10-06' }]);
    const statuses: string[] = (query.mock.calls as any[])[0][1][1];
    expect(statuses).not.toContain('PENDING');
    expect(statuses).toEqual(expect.arrayContaining(['ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS']));
  });
});

// ── E9: reassign until check-in ───────────────────────────────────────────────────────────────

describe('E9 — reassign until check-in, through the table', () => {
  it('declares exactly PENDING, ACCEPTED and REJECTED as reassignable', () => {
    expect([...REASSIGNABLE_ASSIGNMENT_STATUSES].sort()).toEqual(['ACCEPTED', 'PENDING', 'REJECTED']);
    expect(canTransitionAssignment(AssignmentStatus.ACCEPTED, AssignmentStatus.PENDING)).toBe(true);
    expect(canTransitionAssignment(AssignmentStatus.PENDING, AssignmentStatus.PENDING)).toBe(true);
    expect(canTransitionAssignment(AssignmentStatus.REJECTED, AssignmentStatus.PENDING)).toBe(true);
    for (const s of [AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED]) {
      expect(ASSIGNMENT_TRANSITIONS[s]).not.toContain(AssignmentStatus.PENDING);
    }
  });

  it('the state machine moves through the table and refuses a visit under way', () => {
    const a: any = { status: AssignmentStatus.ACCEPTED };
    expect(AssignmentStateMachine.reassign(a, 'u')).toMatchObject({ previousState: 'ACCEPTED', newState: 'PENDING' });
    expect(a.status).toBe(AssignmentStatus.PENDING);
    expect(() => AssignmentStateMachine.reassign({ status: AssignmentStatus.CHECKED_IN } as any, 'u')).toThrow(/Invalid transition/);
  });

  it('the service writes the move through the state machine, not by assigning the column', () => {
    const source = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');
    const from = source.indexOf('  async reassignAssignment(');
    const body = source.slice(from, source.indexOf('\n  async ', from + 10));
    expect(body).toContain('AssignmentStateMachine.reassign(assignment, userId);');
    expect(body).not.toMatch(/assignment\.status = AssignmentStatus\.PENDING/);
  });

  it.each([AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS])(
    'refuses a %s job with REASSIGN_AFTER_CHECK_IN, telling the desk to cancel instead, and writes nothing',
    async (status) => {
      const manager: any = {
        query: jest.fn(async (sql: string) => (/FOR UPDATE/.test(sql) && /assignments/.test(sql)
          ? [{ status, assayer_id: 'as-old', entity_version: 3 }] : [])),
        findOne: jest.fn(async () => ({ id: 'asn-1', assayerId: 'as-old' })),
        save: jest.fn(),
      };
      const svc: any = Object.create(AssignmentService.prototype);
      svc.uow = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
      svc.assignmentRepository = { manager: { query: jest.fn(async () => []) }, findOne: jest.fn(async () => null) };
      svc.assayerService = { findOne: jest.fn(async () => ({ id: 'as-new', status: AssayerStatus.ACTIVE, isActive: true })) };
      svc.notificationDispatch = { emitSafe: jest.fn() };

      let thrown: any;
      try { await (svc as AssignmentService).reassignAssignment('asn-1', 'as-new', 'ops-1', 'nearer'); } catch (e) { thrown = e; }

      expect(codeOf(thrown)).toBe('REASSIGN_AFTER_CHECK_IN');
      expect(thrown.message).toMatch(/Cancel it instead/);
      expect(manager.save).not.toHaveBeenCalled();
      expect(svc.notificationDispatch.emitSafe).not.toHaveBeenCalled();
    },
  );
});

// ── Completion notices: the catalog wording ────────────────────────────────────────────────────

describe('completion and office check-in notices read as the owner worded them', () => {
  it('ASSIGNMENT_COMPLETED goes to the assayer', () => {
    const def = NOTIFICATION_CATALOG.ASSIGNMENT_COMPLETED;
    expect(def).toMatchObject({ title: 'Job complete', special: ['ASSIGNED_ASSAYER'], roles: [] });
    expect(renderTemplate(def.body, { branchName: 'Thrissur Main' })).toBe('Your job at Thrissur Main is complete. Thank you.');
  });

  it('ASSIGNMENT_COMPLETED_DESK goes to whoever created the job', () => {
    const def = NOTIFICATION_CATALOG.ASSIGNMENT_COMPLETED_DESK;
    expect(def).toMatchObject({ special: ['RECORD_OWNER'], roles: [] });
    expect(renderTemplate(def.body, { branchName: 'Thrissur Main', assayerName: 'Anu Joseph' }))
      .toBe('Audit at Thrissur Main completed — Anu Joseph.');
  });

  it('ASSIGNMENT_CHECKED_IN_BY_OFFICE is neutral and carries the reason', () => {
    const def = NOTIFICATION_CATALOG.ASSIGNMENT_CHECKED_IN_BY_OFFICE;
    expect(def).toMatchObject({ title: 'Checked in by the office', special: ['ASSIGNED_ASSAYER'] });
    expect(renderTemplate(def.body, { branchName: 'Kochi', reason: 'Phone died.' }))
      .toBe('The office checked you in at Kochi. Reason: Phone died.');
  });
});

// ── E11: schedule notices keyed per occurrence ─────────────────────────────────────────────────

describe('E11 — schedule dispatch and reschedule notices are keyed per occurrence', () => {
  const makeScheduling = () => {
    let version = 4;
    const schedule: any = {
      id: 'sch-1', assignmentId: 'asn-1', assayerId: 'as-1', status: ScheduleStatus.CONFIRMED, scheduledDate: new Date('2026-10-01'),
      assignment: { status: 'ACCEPTED', projectBranch: { status: 'SCHEDULED', branch: { name: 'Kochi' } } },
    };
    const svc: any = Object.create(SchedulingService.prototype);
    svc.scheduleRepository = { findOne: jest.fn(async () => schedule), save: jest.fn(async (x: any) => x) };
    svc.assignmentService = { scheduleAudit: jest.fn(async () => ({ entityVersion: ++version })) };
    svc.auditService = { recordEvent: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.notificationDispatch = { emitSafe: jest.fn() };
    return svc;
  };

  it('A → B → A → B sends four reschedule notices, not two', async () => {
    const svc = makeScheduling();
    for (const day of ['2026-10-02', '2026-10-01', '2026-10-02', '2026-10-01']) {
      await svc.transition('sch-1', ScheduleStatus.RESCHEDULED, 'ops-1', undefined, day);
    }
    const keys = svc.notificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].dedupeKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe('SCHEDULE_RESCHEDULED:sch-1:2026-10-02:5');
  });

  it('the dispatch key carries the version the dating committed', () => {
    const svc: any = makeScheduling();
    svc.emitDispatchNotification({ id: 'asn-1', assayerId: 'as-1' }, 'sch-1', '2026-10-02', 'ops-1', 7);
    svc.emitDispatchNotification({ id: 'asn-1', assayerId: 'as-1' }, 'sch-1', '2026-10-02', 'ops-1', 9);
    const keys = svc.notificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].dedupeKey);
    expect(keys).toEqual(['SCHEDULE_DISPATCHED:sch-1:2026-10-02:7', 'SCHEDULE_DISPATCHED:sch-1:2026-10-02:9']);
  });
});
