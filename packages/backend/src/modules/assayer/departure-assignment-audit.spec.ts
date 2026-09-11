import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { AssayerLifecycleStatus, AssignmentStatus, EventCategory } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';

/**
 * AN ASSIGNMENT CANCELLED BY A DEPARTURE LEAVES A RECORD ON THE ASSIGNMENT.
 *
 * `cancelOpenAssignmentsOnDeparture` raw-UPDATEd in-flight assignments to CANCELLED, bumped
 * `entity_version`, and wrote **zero** audit rows against them. The only trail was one row on the
 * ASSAYER saying `4 open assignments cancelled` — which names neither the assignments, nor the
 * branches, nor the clients whose work stopped.
 *
 * So the question an operations lead actually asks — standing in front of one branch that is
 * suddenly unassigned, "what happened to this job, and who did it?" — had no answer anywhere. The
 * assignment's own history skipped from ACCEPTED to nothing. `cancel_reason` was the only clue,
 * on a mutable column, with no actor and no timestamp beside it.
 *
 * Every other cancel path writes `ASSIGNMENT_CANCELLED` through `assignment.service.ts`. This one
 * bypassed the service — a raw UPDATE, for the good reason that the state machine's cancel
 * command demands things a cascade cannot supply — and took the audit row with it.
 *
 * ## What these cases hold
 *
 * One row per affected assignment, in the SAME transaction as the state change, carrying the
 * previous status, the new status, the reason, the actor, the previous assayer and a correlation
 * back to the lifecycle event. And, just as important in the other direction: COMPLETED, REJECTED
 * and already-CANCELLED work is neither mutated nor audited, because nothing happened to it.
 */
describe('assignments cancelled by a departure', () => {
  let service: AssayerService;

  /** The rows the cascade's `UPDATE … RETURNING` hands back — what it actually changed. */
  let cancelledRows: any[];
  /** Every `recordEvent` call, in order, with the manager it was given. */
  let events: Array<{ dto: any; scope: any }>;
  /** What the transition's `SELECT … FOR UPDATE` finds — the state it is moving away from. */
  let lockedState: AssayerLifecycleStatus;

  const person = (over: Record<string, unknown> = {}) => ({
    id: 'as-1',
    displayName: 'Priya Nair',
    firstName: 'Priya',
    lastName: 'Nair',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    status: 'ACTIVE',
    isActive: true,
    joiningDate: '2024-01-10',
    exitDate: null,
    terminationDate: null,
    unavailableReason: null,
    ...over,
  }) as any;

  const mockAssayerManager = { count: jest.fn().mockResolvedValue(0), query: jest.fn().mockResolvedValue([]) };
  const mockAssayerRepo: any = {
    create: jest.fn(), findAndCount: jest.fn(), find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(async (e: any) => e),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: mockAssayerManager,
    metadata: { findColumnWithPropertyName: (name: string) => ({ propertyName: name, isNullable: true }) },
  };
  const mockActivityRepo = { create: jest.fn((v: any) => v), save: jest.fn(async (v: any) => v) };
  const inert = { create: jest.fn((v: any) => v), save: jest.fn(async (v: any) => v), findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };

  /**
   * The SQL seam. `assignments` returns the rows the cascade cancelled; everything else answers
   * the way an empty result does, so one mock serves the empanelment close and the schedule
   * sweep without either pretending to have done anything.
   */
  const answer = async (sql: string, ..._params: unknown[]) => {
    // The transition's own row lock. Without an answer here the service correctly 404s, so this
    // is what makes the spec exercise the transactional path rather than the manager-less one.
    if (/FROM assayers\b/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      return [{ lifecycle_status: lockedState, version: 1 }];
    }
    if (/UPDATE\s+assignments\b/i.test(sql)) return cancelledRows;
    if (/UPDATE\s+assayer_client_empanelments\b/i.test(sql)) return [[], 0];
    return [];
  };
  const mockDataSource = { query: jest.fn(answer) };

  const mockUowManager = {
    getRepository: jest.fn((entity: any) => {
      if (entity === AssayerEntity) return mockAssayerRepo;
      if (entity === AssayerActivityEntity) return mockActivityRepo;
      return inert;
    }),
    // Forwards the PARAMETERS too: the open-status set is asserted off them below, and a
    // seam that dropped them would make that assertion untestable.
    query: (...args: any[]) => (mockDataSource.query as any)(...args),
  };
  const mockUow = { run: jest.fn((work: any) => work(mockUowManager)) };

  const mockAuditService = {
    recordEvent: jest.fn(async (dto: any, scope: any) => { events.push({ dto, scope }); return { id: 'ae-1' }; }),
    recordEventSafe: jest.fn(async (dto: any, scope: any) => { events.push({ dto, scope }); }),
  };

  beforeEach(async () => {
    cancelledRows = [];
    events = [];
    lockedState = AssayerLifecycleStatus.ACTIVE;
    jest.clearAllMocks();
    mockDataSource.query.mockImplementation(answer);
    mockAssayerRepo.save.mockImplementation(async (e: any) => e);

    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: inert },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: inert },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: inert },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: mockActivityRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        {
          provide: WorkflowEngine,
          useValue: {
            registerWorkflow: jest.fn(),
            // The real engine opens a transaction and hands the action its manager. Calling
            // `action()` bare would test the one path production never takes — and would quietly
            // pass the "same transaction" case below by giving it nothing to be wrong about.
            executeCommand: jest.fn(async (_k, _i, _c, _f, _t, _u, _r, _rs, action: any) => action(mockUowManager)),
          },
        },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: EmailProvider, useValue: { send: jest.fn().mockResolvedValue({ success: false }) } },
        { provide: SmsProvider, useValue: { send: jest.fn().mockResolvedValue(false) } },
        { provide: UnitOfWork, useValue: mockUow },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = mod.get(AssayerService);
  });

  /** One row as the `UPDATE … RETURNING` reports it. */
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'asg-1',
    assignment_number: 'ASG-0001',
    previous_status: AssignmentStatus.ACCEPTED,
    previous_version: 3,
    new_version: 4,
    scheduled_date: '2026-09-20',
    project_branch_id: 'pb-1',
    ...over,
  });

  const assignmentEvents = () => events.filter((e) => e.dto.entityType === 'ASSIGNMENT');
  const lifecycleEvent = () => events.find((e) => e.dto.eventType === 'ASSAYER_LIFECYCLE_TRANSITION');

  // ── one assignment ────────────────────────────────────────────────────────
  describe('one assignment in flight', () => {
    beforeEach(() => {
      mockAssayerRepo.findOne.mockResolvedValue(person());
      cancelledRows = [row()];
    });

    it('writes an audit row against the assignment, not only against the person', async () => {
      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      expect(assignmentEvents()).toHaveLength(1);
      const { dto } = assignmentEvents()[0];
      expect(dto.entityId).toBe('asg-1');
      expect(dto.eventType).toBe('ASSIGNMENT_CANCELLED');
      expect(dto.category).toBe(EventCategory.OPERATIONAL);
    });

    /** Everything the finding asked to be preserved, checked one field at a time. */
    it('preserves the previous status, the new status, the reason and the actor', async () => {
      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      const { dto } = assignmentEvents()[0];
      expect(dto.previousState).toBe(AssignmentStatus.ACCEPTED);
      expect(dto.newState).toBe(AssignmentStatus.CANCELLED);
      expect(dto.userId).toBe('u-9');
      expect(dto.remarks).toMatch(/RESIGNED/);
      expect(dto.remarks).toMatch(/could not proceed as planned/);
      expect(dto.metadata.previousValue).toEqual({ status: AssignmentStatus.ACCEPTED, entityVersion: 3 });
      expect(dto.metadata.newValue).toEqual({ status: AssignmentStatus.CANCELLED, entityVersion: 4 });
    });

    /**
     * The assayer is not cleared off the assignment by the cascade, but a reader looking at a
     * cancelled job months later should not have to infer who it was taken from.
     */
    it('names the assayer the work was taken from, and what ended it', async () => {
      // A dismissal is reached only through a suspension — ACTIVE → TERMINATED is illegal.
      lockedState = AssayerLifecycleStatus.SUSPENDED;
      mockAssayerRepo.findOne.mockResolvedValue(
        person({ lifecycleStatus: AssayerLifecycleStatus.SUSPENDED, status: 'SUSPENDED' }),
      );
      await service.terminateAssayer('as-1', 'u-9', 'Gross misconduct.');

      const { dto } = assignmentEvents()[0];
      expect(dto.metadata.cause).toBe('ASSAYER_DEPARTURE');
      expect(dto.metadata.previousAssayerId).toBe('as-1');
      expect(dto.metadata.lifecycleTarget).toBe(AssayerLifecycleStatus.TERMINATED);
    });

    /**
     * The correlation. Without it, joining "she resigned" to "this branch is unassigned" is a
     * guess from two timestamps a second apart.
     */
    it('correlates the cancellation to the lifecycle event that caused it', async () => {
      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      const onAssignment = assignmentEvents()[0].dto.metadata.departureEventId;
      expect(typeof onAssignment).toBe('string');
      expect(onAssignment).toHaveLength(36);
      expect(lifecycleEvent()!.dto.metadata.departureEventId).toBe(onAssignment);
      expect(lifecycleEvent()!.dto.metadata.assignmentsCancelled).toBe(1);
    });

    /**
     * The same transaction as the state change. A cancellation that cannot be recorded must not
     * commit — which is why this is `recordEvent` and not the swallowing `recordEventSafe`.
     */
    it('writes the row on the transition\'s own manager, so it commits or rolls back with it', async () => {
      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      expect(assignmentEvents()[0].scope).toEqual({ manager: mockUowManager });
      expect(mockAuditService.recordEventSafe).not.toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'ASSIGNMENT' }), expect.anything(),
      );
    });

    it('carries the branch and the date, so the row explains itself', async () => {
      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      const { dto } = assignmentEvents()[0];
      expect(dto.metadata.assignmentNumber).toBe('ASG-0001');
      expect(dto.metadata.projectBranchId).toBe('pb-1');
      expect(dto.metadata.scheduledDate).toBe('2026-09-20');
    });
  });

  // ── several assignments ───────────────────────────────────────────────────
  describe('several assignments in flight', () => {
    it('writes one row per assignment, each true of that assignment', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(person());
      cancelledRows = [
        row({ id: 'asg-1', assignment_number: 'ASG-0001', previous_status: AssignmentStatus.PENDING, previous_version: 1, new_version: 2 }),
        row({ id: 'asg-2', assignment_number: 'ASG-0002', previous_status: AssignmentStatus.ACCEPTED, previous_version: 5, new_version: 6 }),
        row({ id: 'asg-3', assignment_number: 'ASG-0003', previous_status: AssignmentStatus.IN_PROGRESS, previous_version: 2, new_version: 3 }),
      ];

      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      const dtos = assignmentEvents().map((e) => e.dto);
      expect(dtos.map((d) => d.entityId)).toEqual(['asg-1', 'asg-2', 'asg-3']);
      // The previous status is per row. A single aggregate row could never have said this.
      expect(dtos.map((d) => d.previousState)).toEqual([
        AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED, AssignmentStatus.IN_PROGRESS,
      ]);
      expect(dtos.every((d) => d.newState === AssignmentStatus.CANCELLED)).toBe(true);
      // All three belong to the same departure.
      expect(new Set(dtos.map((d) => d.metadata.departureEventId)).size).toBe(1);
      expect(lifecycleEvent()!.dto.metadata.assignmentsCancelled).toBe(3);
    });
  });

  // ── work that must NOT be touched ─────────────────────────────────────────
  describe('work that already ended', () => {
    /**
     * The predicate, asserted at the SQL rather than through the mock's answer — a test that only
     * checked the audit rows would pass against a cascade that cancelled everything and simply
     * audited what it cancelled.
     */
    it('asks the database only for genuinely open work', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(person());
      cancelledRows = [];

      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      const call = mockDataSource.query.mock.calls.find(([sql]: any) => /UPDATE\s+assignments\b/i.test(sql));
      const sql = call![0] as string;
      expect(sql).toMatch(/status\s*=\s*ANY\(\$5\)/);
      expect(sql).not.toMatch(/status\s*!=/);
      // COMPLETED, CANCELLED and REJECTED are absent from the parameter, so they are outside the
      // UPDATE entirely — not mutated, and therefore correctly not audited either.
      const params = (call as any)[1] as unknown[];
      const openSet = params[4] as string[];
      expect(openSet).toEqual([
        AssignmentStatus.PENDING, AssignmentStatus.ACCEPTED,
        AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS,
      ]);
      for (const historical of [AssignmentStatus.COMPLETED, AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED]) {
        expect(openSet).not.toContain(historical);
      }
    });

    /**
     * A departure with nothing open writes no assignment rows at all. The previous shape of this
     * defect was the mirror image — a second resignation reporting "1 open assignment cancelled"
     * for work an earlier decision had already closed.
     */
    it('writes nothing when a completed, cancelled or rejected job is all there is', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(person());
      cancelledRows = [];

      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      expect(assignmentEvents()).toHaveLength(0);
      expect(lifecycleEvent()!.dto.metadata.assignmentsCancelled).toBe(0);
      // And the departure itself is still recorded — the person left either way.
      expect(lifecycleEvent()!.dto.newState).toBe(AssayerLifecycleStatus.RESIGNED);
    });

    /**
     * The mixed case, which is the one a real roster produces: some work delivered, some
     * declined, one job still open. Only the open one is reported by the UPDATE, so only the open
     * one is audited — and the aggregate count on the person agrees with the rows.
     */
    it('audits only the open job when history sits beside it', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(person());
      cancelledRows = [row({ id: 'asg-open', previous_status: AssignmentStatus.CHECKED_IN })];

      await service.acceptResignation('as-1', 'u-9', 'Relocating to Kochi.');

      expect(assignmentEvents().map((e) => e.dto.entityId)).toEqual(['asg-open']);
      expect(assignmentEvents()[0].dto.previousState).toBe(AssignmentStatus.CHECKED_IN);
      expect(lifecycleEvent()!.dto.metadata.assignmentsCancelled).toBe(1);
    });
  });

  // ── scope ─────────────────────────────────────────────────────────────────
  describe('scope', () => {
    /**
     * SUSPENDED is "not right now", not "not any more". No cascade, so no assignment rows — and
     * an audit row claiming a cancellation that did not happen would be worse than none.
     */
    it('writes no assignment rows for a move that is not a departure', async () => {
      mockAssayerRepo.findOne.mockResolvedValue(person());
      cancelledRows = [row()];

      await service.suspendAssayer('as-1', 'u-9', 'Under investigation.');

      expect(assignmentEvents()).toHaveLength(0);
      expect(mockDataSource.query.mock.calls.some(([sql]: any) => /UPDATE\s+assignments\b/i.test(sql))).toBe(false);
      expect(lifecycleEvent()!.dto.metadata?.departureEventId).toBeUndefined();
    });

    it('does the same for both kinds of departure', async () => {
      for (const [move, target] of [
        ['acceptResignation', AssayerLifecycleStatus.RESIGNED],
        ['terminateAssayer', AssayerLifecycleStatus.TERMINATED],
      ] as const) {
        events = [];
        lockedState = target === AssayerLifecycleStatus.TERMINATED
          ? AssayerLifecycleStatus.SUSPENDED : AssayerLifecycleStatus.ACTIVE;
        mockAssayerRepo.findOne.mockResolvedValue(person(
          target === AssayerLifecycleStatus.TERMINATED
            ? { lifecycleStatus: AssayerLifecycleStatus.SUSPENDED, status: 'SUSPENDED' }
            : {},
        ));
        cancelledRows = [row()];

        await (service as any)[move]('as-1', 'u-9', 'A stated reason.');

        expect(assignmentEvents()).toHaveLength(1);
        expect(assignmentEvents()[0].dto.metadata.lifecycleTarget).toBe(target);
      }
    });
  });
});
