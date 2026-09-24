import { readFileSync } from 'fs';
import { join } from 'path';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { AssignmentStatus, AssayerStatus, ProjectBranchStatus, Priority, ScheduleStatus } from '@fapoms/shared';
import { attendanceDeadline, offerResponseDeadline, DEFAULT_MAX_RESPONSE_TIME_HOURS } from './assignment-sla';
import { assignmentOccurrenceKey, checkInOccurrenceKey } from './assignment-notification-keys';
import { evaluateAcceptOffer } from './assignment-capabilities';
import { NOTIFICATION_CATALOG, renderTemplate } from '../notifications/notification-catalog';

/**
 * The assignment-lifecycle audit (2026-09-24): E3 SLA clock, E4 reassign cleanup, E5 the
 * CHECKED_IN -> ACCEPTED edge, E10 one auto-decline notice, E11 occurrence dedupe keys, E13
 * reassign notices after commit, E14 office wording on a cancellation, E17 the small ones.
 * Closure cascades (E7) are in notifications/closure-cancellation-notice.spec.ts, the invoice
 * settlement rule (E15) in billing-engine/assayer-invoice-settlement.spec.ts.
 */

const IST_END_OF = (day: string) => new Date(`${day}T23:59:59+05:30`);

// ── A transition harness: the real executeAssignmentTransition over an in-memory row ──────────

function transitionHarness(row: any, opts: { schedule?: any } = {}) {
  const svc: any = Object.create(AssignmentService.prototype);
  svc.constraintEvaluator = { checkDateAvailability: jest.fn(async () => ({ passed: true })), checkSkillsAndCertifications: jest.fn(() => ({ passed: true })), checkDistancePolicy: jest.fn(() => ({ passed: true })) };
  const initialStatus = row.status;
  const saved: any[] = [];
  const scheduleRepo = {
    findOne: jest.fn(async () => opts.schedule ?? null),
    save: jest.fn(async (x: any) => ({ id: x.id ?? 'sched-1', ...x })),
    create: jest.fn((x: any) => x),
  };
  const manager: any = {
    query: jest.fn(async (sql: string) =>
      /FOR UPDATE/.test(sql) ? [{ status: initialStatus, entity_version: row.entityVersion ?? 1 }] : []),
    save: jest.fn(async (e: any) => { saved.push({ ...e }); return e; }),
    findOne: jest.fn(async () => row),
    getRepository: jest.fn(() => scheduleRepo),
  };
  svc.assignmentRepository = {
    findOne: jest.fn(async () => row),
    find: jest.fn(async () => [row]),
    save: jest.fn(async (e: any) => e),
    manager: { query: jest.fn(async () => []) },
  };
  svc.assayerService = {
    findOne: jest.fn(async () => ({ id: row.assayerId, status: AssayerStatus.ACTIVE, isActive: true })),
    enableLiveTrackingForActiveWork: jest.fn(async () => undefined),
    disableLiveTrackingWhenWorkEnds: jest.fn(async () => undefined),
    scheduleStatsRefresh: jest.fn(),
  };
  svc.uow = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
  svc.constraintEvaluator = { checkDateAvailability: jest.fn(async () => ({ passed: true })), checkSkillsAndCertifications: jest.fn(() => ({ passed: true })), checkDistancePolicy: jest.fn(() => ({ passed: true })) };
  svc.auditService = { recordEventSafe: jest.fn(async () => undefined), recordEvent: jest.fn(async () => ({ id: 'ev' })) };
  svc.notificationDispatch = { emitSafe: jest.fn() };
  svc.operationsInbox = { resolveChannels: jest.fn(async () => new Map()) };
  svc.validationService = { getOrCreateForBranch: jest.fn() };
  const emitted = (type?: string) => svc.notificationDispatch.emitSafe.mock.calls
    .map((c: any[]) => c[0]).filter((e: any) => !type || e.type === type);
  return { svc: svc as AssignmentService, manager, saved, scheduleRepo, emitted, raw: svc };
}

const offerRow = (over: any = {}) => ({
  id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.PENDING, assayerId: 'assayer-1',
  assayer: { firstName: 'Arun', lastName: 'D' }, createdBy: 'ops-0',
  scheduledDate: new Date('2026-10-05T00:00:00+05:30'), autoSchedule: true,
  // The offer's response deadline, long gone — the state an accepted job used to keep.
  slaDueDate: new Date('2026-09-01T10:00:00Z'), slaStatus: 'BREACHED',
  projectBranch: { id: 'pb-1', status: ProjectBranchStatus.PLANNING, isActive: true, branch: { name: 'Thrissur Main' } },
  entityVersion: 3, ...over,
});

// ── E3 ───────────────────────────────────────────────────────────────────────────────────────

describe('E3 — the SLA clock follows what the assignment is waiting for', () => {
  it('the two clocks are what they say', () => {
    const from = new Date('2026-09-24T06:00:00Z');
    expect(offerResponseDeadline(null, from).getTime() - from.getTime()).toBe(DEFAULT_MAX_RESPONSE_TIME_HOURS * 3600_000);
    expect(offerResponseDeadline({ maxResponseTimeHours: 6 }, from).getTime() - from.getTime()).toBe(6 * 3600_000);
    expect(attendanceDeadline(new Date('2026-10-05T00:00:00+05:30'))).toEqual(IST_END_OF('2026-10-05'));
    expect(attendanceDeadline(null)).toBeNull();
  });

  it('accepting re-arms slaDueDate to the end of the scheduled day (IST) and clears a breach', async () => {
    const row = offerRow();
    const { svc, saved } = transitionHarness(row);
    await svc.acceptOffer('asn-1', 'assayer-1');
    const written = saved.find((s) => s.status === AssignmentStatus.ACCEPTED);
    expect(written.slaDueDate).toEqual(IST_END_OF('2026-10-05'));
    expect(written.slaStatus).toBe('COMPLIANT');
  });

  it('an accepted job with no scheduled date keeps the clock it had (legacy rows only)', async () => {
    const before = new Date('2026-09-01T10:00:00Z');
    const row = offerRow({ scheduledDate: null, slaDueDate: before, slaStatus: 'COMPLIANT' });
    const { svc, saved } = transitionHarness(row);
    await svc.acceptOffer('asn-1', 'assayer-1');
    expect(saved.find((s) => s.status === AssignmentStatus.ACCEPTED).slaDueDate).toEqual(before);
  });

  it('scheduleAudit uses the same rule', () => {
    const src = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');
    const body = src.slice(src.indexOf('async scheduleAudit('), src.indexOf('private publishAssignmentEvent('));
    expect(body).toContain('attendanceDeadline(assignment.scheduledDate)');
    expect(body).not.toContain('~line 914');
  });
});

// ── E5 in the capability list ────────────────────────────────────────────────────────────────

describe('E5 — a checked-in job is not offered ACCEPT', () => {
  it('evaluateAcceptOffer refuses CHECKED_IN with the transition code', () => {
    const gate = evaluateAcceptOffer({ status: AssignmentStatus.CHECKED_IN } as any, null, []);
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('INVALID_ASSIGNMENT_TRANSITION');
  });
});

// ── E10 ──────────────────────────────────────────────────────────────────────────────────────

describe('E10 — an expired offer reaches ops once', () => {
  it('sends ASSIGNMENT_AUTO_DECLINED and not also ASSIGNMENT_REJECTED', async () => {
    const row = offerRow({ slaDueDate: new Date(Date.now() - 60_000), slaStatus: 'COMPLIANT' });
    const { svc, emitted } = transitionHarness(row);
    await svc.autoDeclineExpiredOffers();
    expect(emitted('ASSIGNMENT_REJECTED')).toHaveLength(0);
    const [notice] = emitted('ASSIGNMENT_AUTO_DECLINED');
    // Still addressed to the assayer too — their only word that the offer is gone.
    expect(notice).toMatchObject({ assayerId: 'assayer-1', dedupeKey: 'ASSIGNMENT_AUTO_DECLINED:asn-1:4' });
    expect(NOTIFICATION_CATALOG.ASSIGNMENT_AUTO_DECLINED.special).toContain('ASSIGNED_ASSAYER');
  });

  it('a manual decline still sends ASSIGNMENT_REJECTED', async () => {
    const { svc, emitted } = transitionHarness(offerRow());
    await svc.rejectOffer('asn-1', 'assayer-1', 'Too far');
    expect(emitted('ASSIGNMENT_REJECTED')).toHaveLength(1);
  });
});

// ── E11 ──────────────────────────────────────────────────────────────────────────────────────

describe('E11 — dedupe keys name the occurrence, not just the assignment', () => {
  it('the same event retried keeps its key; a new occurrence on the reused row gets a new one', () => {
    expect(assignmentOccurrenceKey('ASSIGNMENT_OFFERED', { id: 'a', entityVersion: 4 }))
      .toBe(assignmentOccurrenceKey('ASSIGNMENT_OFFERED', { id: 'a', entityVersion: 4 }));
    expect(assignmentOccurrenceKey('ASSIGNMENT_OFFERED', { id: 'a', entityVersion: 4 }))
      .not.toBe(assignmentOccurrenceKey('ASSIGNMENT_OFFERED', { id: 'a', entityVersion: 6 }));
  });

  it('check-in: retries the same day collapse, another assayer or another day does not', () => {
    const k = (assayerId: string, at: string) => checkInOccurrenceKey({ id: 'a', assayerId, checkedInAt: new Date(at) });
    expect(k('x', '2026-09-24T04:00:00Z')).toBe(k('x', '2026-09-24T09:00:00Z'));
    expect(k('x', '2026-09-24T04:00:00Z')).not.toBe(k('y', '2026-09-24T04:00:00Z'));
    expect(k('x', '2026-09-24T04:00:00Z')).not.toBe(k('x', '2026-09-25T04:00:00Z'));
  });

  it('two declines on one reused row are two notices', async () => {
    const first = transitionHarness(offerRow({ entityVersion: 3 }));
    await first.svc.rejectOffer('asn-1', 'assayer-1', 'Too far');
    const second = transitionHarness(offerRow({ entityVersion: 7, assayerId: 'assayer-2' }));
    await second.svc.rejectOffer('asn-1', 'assayer-2', 'On leave');
    const k1 = first.emitted('ASSIGNMENT_REJECTED')[0].dedupeKey;
    const k2 = second.emitted('ASSIGNMENT_REJECTED')[0].dedupeKey;
    expect(k1).not.toBe(k2);
  });

  it('SLA breach and escalation keys carry the version', async () => {
    const row = offerRow({ status: AssignmentStatus.ACCEPTED, slaStatus: 'COMPLIANT', priority: Priority.MEDIUM, entityVersion: 5 });
    const h = transitionHarness(row);
    await h.svc.checkSlaBreaches();
    expect(h.emitted('ASSIGNMENT_SLA_BREACHED')[0].dedupeKey).toBe('ASSIGNMENT_SLA_BREACHED:asn-1:6');

    const e = transitionHarness(offerRow({ status: AssignmentStatus.ACCEPTED, priority: Priority.MEDIUM, entityVersion: 5 }));
    e.raw.publishAssignmentEvent = jest.fn();
    await e.svc.escalate('asn-1', 'ops-1', 'x');
    expect(e.emitted('ASSIGNMENT_ESCALATED')[0].dedupeKey).toBe('ASSIGNMENT_ESCALATED:asn-1:6');
    expect(e.emitted('ASSIGNMENT_MARKED_URGENT')[0].dedupeKey).toBe('ASSIGNMENT_MARKED_URGENT:asn-1:6');
  });

  it('two field issues on the same job both reach the desk (the absent key defaulted to type:id)', async () => {
    const h = transitionHarness(offerRow({ status: AssignmentStatus.ACCEPTED }));
    h.raw.publishAssignmentEvent = jest.fn();
    await h.svc.reportIssue('asn-1', 'assayer-1', 'BRANCH_CLOSED');
    await h.svc.reportIssue('asn-1', 'assayer-1', 'SAFETY_CONCERN');
    const keys = h.emitted('ASSIGNMENT_ISSUE_REPORTED').map((e: any) => e.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('SCHEDULE_DISPATCHED is per acceptance, so a revived calendar row still tells the new assayer', async () => {
    // The row the previous assayer's acceptance created, retired by the reassignment.
    const retired = { id: 'sched-1', assignmentId: 'asn-1', isActive: false, status: ScheduleStatus.CONFIRMED };
    const h = transitionHarness(offerRow({ assayerId: 'assayer-2', entityVersion: 8 }), { schedule: retired });
    await h.svc.acceptOffer('asn-1', 'assayer-2');
    const [dispatch] = h.emitted('SCHEDULE_DISPATCHED');
    expect(dispatch).toMatchObject({ assayerId: 'assayer-2' });
    expect(dispatch.dedupeKey).toBe('SCHEDULE_DISPATCHED:sched-1:assayer-2:9');
  });

  it('no assignment notification is keyed on the bare assignment id any more', () => {
    const src = readFileSync(join(__dirname, 'assignment.service.ts'), 'utf8');
    expect(src).not.toMatch(/dedupeKey: `[A-Z_]+:\$\{[a-zA-Z.]+\.id\}`/);
  });
});

// ── E14 ──────────────────────────────────────────────────────────────────────────────────────

describe('E14 — a cancellation reads right to whoever receives it', () => {
  it('the assayer and the desk get separate notices', async () => {
    const h = transitionHarness(offerRow({ status: AssignmentStatus.ACCEPTED }));
    await h.svc.cancelAssignment('asn-1', 'ops-1', 'Client withdrew the branch');
    const types = h.emitted().map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ASSIGNMENT_CANCELLED', 'ASSIGNMENT_CANCELLED_DESK']));
  });

  it('the assayer copy goes to the assayer alone; the desk copy is in office wording', () => {
    const assayerCopy = NOTIFICATION_CATALOG.ASSIGNMENT_CANCELLED;
    const deskCopy = NOTIFICATION_CATALOG.ASSIGNMENT_CANCELLED_DESK;
    expect(assayerCopy.roles).toEqual([]);
    expect(assayerCopy.special).toEqual(['ASSIGNED_ASSAYER']);
    expect(deskCopy.roles).toEqual(['OPERATIONS']);
    expect(deskCopy.special ?? []).not.toContain('ASSIGNED_ASSAYER');
    const payload = { branchName: 'Thrissur Main', scheduledDate: '2026-10-05', assayerName: 'Arun D', reason: 'Client withdrew' };
    expect(renderTemplate(assayerCopy.body, payload)).toMatch(/^Your audit at Thrissur Main/);
    expect(renderTemplate(deskCopy.body, payload))
      .toBe('Audit at Thrissur Main on 2026-10-05 cancelled — Arun D. Reason: Client withdrew');
  });

  it('the stale proposeCounterFee note is gone', () => {
    const src = readFileSync(join(__dirname, '../notifications/notification-catalog.ts'), 'utf8');
    expect(src).not.toContain('proposeCounterFee');
  });
});

// ── E17 ──────────────────────────────────────────────────────────────────────────────────────

describe('E17 — escalation is for open work only', () => {
  it.each([AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED, AssignmentStatus.COMPLETED])(
    'refuses %s with ASSIGNMENT_CLOSED and tells nobody',
    async (status) => {
      const h = transitionHarness(offerRow({ status, priority: Priority.MEDIUM }));
      const err: any = await h.svc.escalate('asn-1', 'ops-1', 'x').catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: 'ASSIGNMENT_CLOSED' });
      expect(h.emitted()).toHaveLength(0);
      expect(h.raw.assignmentRepository.save).not.toHaveBeenCalled();
    },
  );

  it('assertCanOverrideEmpanelment is gone (it had no callers)', () => {
    expect((AssignmentService.prototype as any).assertCanOverrideEmpanelment).toBeUndefined();
  });

  it('/start asks the shared ownership predicate like every other route', () => {
    const src = readFileSync(join(__dirname, 'assignment.controller.ts'), 'utf8');
    const start = src.slice(src.indexOf("@Post(':id/start')"), src.indexOf("@Post(':id/complete')"));
    expect(start).toContain('evaluateOwnership(');
    expect(start).not.toMatch(/owned\.assayerId !== userId/);
  });
});

// ── Reassignment: E3(b), E4, E13 ────────────────────────────────────────────────────────────

describe('reassignment — fresh clock, clean hand-over, notices after commit', () => {
  const OLD = 'aa000000-0000-4000-a000-00000000000a';
  const NEW = 'bb000000-0000-4000-b000-00000000000b';

  const make = (opts: {
    branchStatus?: ProjectBranchStatus;
    failAtCommit?: boolean;
    newAssayerMissing?: boolean;
    lockedStatus?: AssignmentStatus;
  } = {}) => {
    const log: string[] = [];
    const activeSchedule = { id: 'sched-1', assignmentId: 'asn-1', isActive: true, status: ScheduleStatus.CONFIRMED };
    const scheduleSaves: any[] = [];
    const row: any = {
      id: 'asn-1', assignmentNumber: 'ASN-1', assayerId: OLD,
      assayer: { id: OLD, displayName: 'Outgoing' },
      status: opts.lockedStatus ?? AssignmentStatus.ACCEPTED,
      projectBranchId: 'pb-1',
      projectBranch: { id: 'pb-1', status: opts.branchStatus ?? ProjectBranchStatus.SCHEDULED, project: { clientId: null }, branch: { name: 'Thrissur Main' } },
      scheduledDate: null, entityVersion: 1,
      slaDueDate: new Date('2026-09-01T00:00:00Z'), slaStatus: 'BREACHED',
    };
    const saved: any[] = [];
    const manager: any = {
      query: jest.fn(async (sql: string) => {
        if (/FOR UPDATE/.test(sql) && /assignments/.test(sql)) return [{ status: row.status, assayer_id: OLD, entity_version: 1 }];
        if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) return [{ assayer_id: NEW, entity_version: 2, status: 'PENDING' }];
        return [];
      }),
      findOne: jest.fn(async (target: any) => (target === AssignmentEntity ? row : target === AssignmentReassignmentEntity ? null : null)),
      create: jest.fn((_c: any, dto: any) => ({ id: 'lineage-1', ...dto })),
      save: jest.fn(async (e: any) => { if (e?.status) saved.push({ ...e }); return e; }),
      getRepository: jest.fn((target: any) => {
        if (target !== ScheduleEntity) throw new Error('unexpected repository');
        return {
          findOne: jest.fn(async () => (activeSchedule.isActive ? activeSchedule : null)),
          save: jest.fn(async (x: any) => { scheduleSaves.push({ ...x }); log.push('schedule-retired'); return x; }),
        };
      }),
    };
    const svc: any = Object.create(AssignmentService.prototype);
    svc.constraintEvaluator = { checkDateAvailability: jest.fn(async () => ({ passed: true })), checkSkillsAndCertifications: jest.fn(() => ({ passed: true })), checkDistancePolicy: jest.fn(() => ({ passed: true })) };
    svc.uow = {
      run: jest.fn(async (work: any) => {
        const out = await work(manager, jest.fn());
        log.push('body-done');
        if (opts.failAtCommit) throw new Error('INJECTED: commit failed');
        log.push('committed');
        return out;
      }),
    };
    const pricingRow = { ...row, projectBranch: { ...row.projectBranch, project: { client: { configuration: { maxResponseTimeHours: 12 } } } } };
    svc.assignmentRepository = { manager: { query: jest.fn(async () => []) }, findOne: jest.fn(async () => pricingRow) };
    svc.repriceForAssayer = jest.fn(async () => { log.push('repriced'); return null; });
    svc.auditService = { recordEventSafe: jest.fn() };
    svc.assayerService = {
      findOne: jest.fn(async () => (opts.newAssayerMissing ? null : { id: NEW, status: AssayerStatus.ACTIVE, isActive: true, displayName: 'Incoming', assayerCode: 'AS-NEW' })),
      disableLiveTrackingWhenWorkEnds: jest.fn(async () => { log.push('tracking-off'); }),
    };
    svc.targetEligibility = { evaluate: jest.fn(), resolveBlock: jest.fn() };
    svc.ruleBypass = { noteBypass: jest.fn() };
    svc.projectService = { initiateBranchPlanning: jest.fn(async () => { log.push('branch-planning'); }) };
    svc.notificationDispatch = { emitSafe: jest.fn((e: any) => log.push(`notify:${e.type}`)) };
    svc.refreshPush = { assignmentChanged: jest.fn(() => log.push('refresh')) };
    return { svc: svc as AssignmentService, raw: svc, log, saved, scheduleSaves, row };
  };
  const go = (svc: AssignmentService) => svc.reassignAssignment('asn-1', NEW, 'ops-1', 'nearer assayer');

  it('E3(b) starts a fresh response deadline from the client window, COMPLIANT', async () => {
    const { svc, saved } = make();
    const before = Date.now();
    await go(svc);
    const w = saved[0];
    expect(w.slaStatus).toBe('COMPLIANT');
    const due = new Date(w.slaDueDate).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 12 * 3600_000 - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 12 * 3600_000 + 1000);
  });

  it('E3(b) the new offer is not auto-declined by the next sweep (its deadline is ahead)', async () => {
    const { svc, saved } = make();
    await go(svc);
    const h = transitionHarness({ ...saved[0], status: AssignmentStatus.PENDING, assayer: null, projectBranch: { branch: { name: 'X' } } });
    const n = await h.svc.autoDeclineExpiredOffers();
    expect(n).toBe(0);
    expect(h.emitted()).toHaveLength(0);
  });

  it("E4 retires the outgoing assayer's calendar entry, like a decline or cancel", async () => {
    const { svc, scheduleSaves } = make();
    await go(svc);
    expect(scheduleSaves).toEqual([expect.objectContaining({ id: 'sched-1', isActive: false, updatedBy: 'ops-1' })]);
  });

  it.each([ProjectBranchStatus.ASSIGNMENT_CONFIRMED, ProjectBranchStatus.SCHEDULED])(
    'E4 puts a %s branch back to PLANNING, as a fresh offer has it',
    async (branchStatus) => {
      const { svc, raw } = make({ branchStatus });
      await go(svc);
      expect(raw.projectService.initiateBranchPlanning).toHaveBeenCalledWith('pb-1', 'ops-1', expect.anything());
    },
  );

  /**
   * Superseded by owner decision 2026-09-24 (E9): re-offering a DECLINED job through reassign puts
   * its branch back in PLANNING, exactly as `create()` does when it re-offers the declined row. It
   * used to be left at CANDIDATE_SEARCH, so the same re-offer read differently by which button made it.
   */
  it('E9 puts a declined job\'s branch (CANDIDATE_SEARCH) back to PLANNING, as create does', async () => {
    const { svc, raw } = make({ branchStatus: ProjectBranchStatus.CANDIDATE_SEARCH, lockedStatus: AssignmentStatus.REJECTED });
    await go(svc);
    expect(raw.projectService.initiateBranchPlanning).toHaveBeenCalledWith('pb-1', 'ops-1', expect.anything());
  });

  it('E9 leaves some other branch state alone when the job was a live offer', async () => {
    const { svc, raw } = make({ branchStatus: ProjectBranchStatus.CANDIDATE_SEARCH, lockedStatus: AssignmentStatus.PENDING });
    await go(svc);
    expect(raw.projectService.initiateBranchPlanning).not.toHaveBeenCalled();
  });

  it("E4 switches the outgoing assayer's location sharing off (the helper keeps it on if other work remains)", async () => {
    const { svc, raw } = make();
    await go(svc);
    expect(raw.assayerService.disableLiveTrackingWhenWorkEnds).toHaveBeenCalledWith(OLD, 'ops-1');
  });

  it('E13 tells nobody until the transaction has committed', async () => {
    const { svc, log } = make();
    await go(svc);
    const committedAt = log.indexOf('committed');
    const firstNotice = log.findIndex((l) => l.startsWith('notify:') || l === 'refresh' || l === 'tracking-off');
    expect(committedAt).toBeGreaterThan(-1);
    expect(firstNotice).toBeGreaterThan(committedAt);
    expect(log.filter((l) => l.startsWith('notify:'))).toEqual(
      ['notify:ASSIGNMENT_REASSIGNED_AWAY', 'notify:ASSIGNMENT_OFFERED', 'notify:ASSIGNMENT_REASSIGNED'],
    );
  });

  it('E13 a move that fails at commit tells nobody', async () => {
    const { svc, log } = make({ failAtCommit: true });
    await expect(go(svc)).rejects.toThrow();
    expect(log.some((l) => l.startsWith('notify:') || l === 'refresh' || l === 'tracking-off')).toBe(false);
  });

  it('E13 an unknown new assayer is refused before anything is priced', async () => {
    const { svc, raw } = make({ newAssayerMissing: true });
    await expect(go(svc)).rejects.toThrow(/not found/);
    expect(raw.repriceForAssayer).not.toHaveBeenCalled();
  });
});

// ── E17(e): what reopen keeps ────────────────────────────────────────────────────────────────

describe('E17(e) — reopen keeps the office note and puts the reason on the record', () => {
  it('records the reason on the audit event and the notice, and leaves remarks alone', async () => {
    const row: any = {
      id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.COMPLETED, assayerId: 'assayer-1',
      remarks: 'Bring the seal.', checkedInAt: new Date(), entityVersion: 4, projectBranch: { branch: { name: 'X' } },
    };
    const saved: any[] = [];
    const manager: any = {
      query: jest.fn(async (sql: string) => (/FOR UPDATE/.test(sql) ? [{ status: 'COMPLETED', entity_version: 4 }] : [])),
      findOne: jest.fn(async (target: any) => (target === AssignmentEntity ? row : null)),
      save: jest.fn(async (e: any) => { saved.push({ ...e }); return e; }),
      getRepository: jest.fn(() => ({ findOne: jest.fn(async () => null), save: jest.fn(async (x: any) => x) })),
    };
    const svc: any = Object.create(AssignmentService.prototype);
    svc.constraintEvaluator = { checkDateAvailability: jest.fn(async () => ({ passed: true })), checkSkillsAndCertifications: jest.fn(() => ({ passed: true })), checkDistancePolicy: jest.fn(() => ({ passed: true })) };
    svc.assignmentRepository = { manager: { query: jest.fn(async () => []) } };
    svc.uow = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
    svc.auditService = { recordEventSafe: jest.fn() };
    svc.billingEngine = { voidPayable: jest.fn() };
    svc.notificationDispatch = { emitSafe: jest.fn() };
    await (svc as AssignmentService).reopen('asn-1', 'ops-1', 'Return was for the wrong branch');
    expect(saved[0].remarks).toBe('Bring the seal.');
    expect(svc.auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ASSIGNMENT_REOPENED', remarks: 'Return was for the wrong branch' }),
      expect.anything(),
    );
    expect(svc.notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ASSIGNMENT_REOPENED', payload: expect.objectContaining({ reason: 'Return was for the wrong branch' }) }),
    );
  });
});
