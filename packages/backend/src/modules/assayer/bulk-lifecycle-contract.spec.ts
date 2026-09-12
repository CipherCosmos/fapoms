/**
 * THE BULK LIFECYCLE CONTRACT.
 *
 * `POST /assayers/bulk/lifecycle` does not perform a transition; it plans a ROUTE and walks it.
 * Each hop of that walk is its own transaction, its own audit row and its own set of cascading
 * side effects, so a walk that stops half way has genuinely moved somebody — and the response
 * used to call that outcome `failed`. An operator reading "failed" stops looking. The database
 * disagreed with the answer they were given, which is worse than either a failure or a partial
 * move on its own.
 *
 * What this file pins:
 *
 *   1. The contract is STAGED, not atomic, and the reason is structural — see the docblock on
 *      `bulkTransitionLifecycle`. There is no reverse edge to walk back along and `audit_events`
 *      is append-only, so "put them back exactly where they were" is not a move this domain has.
 *   2. Staged does NOT mean "find out half way". Every refusal that is a property of the plan —
 *      the path, the per-hop reason, the identity gate under enforce — is decided before the
 *      first hop, and the row is reported `skipped` with nothing changed.
 *   3. Whatever is left is reported as `partial`, naming the state the person is actually in,
 *      read back from the row rather than inferred from how far the loop got.
 *   4. `failed` means the record is exactly where it started. That is the invariant the whole
 *      exercise exists to establish, and `never reports a moved row as failed` below is the test
 *      that would have caught the original defect.
 *
 * These are behavioural tests against a store-backed harness rather than source-text assertions:
 * the bug was not visible in the shape of the code, only in what came back.
 */
import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AssayerLifecycleStatus } from '@fapoms/shared';
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
import { NotificationService } from '../notifications/notification.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { RosterRecordsService } from './roster-records.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

type Row = { id: string; lifecycleStatus: string; version: number; isActive: boolean; displayName: string };

describe('bulk lifecycle — the contract between the response and the database', () => {
  let service: AssayerService;

  /** The database, such as it is: the one table this walk writes to. */
  let rows: Map<string, Row>;
  /** Every lifecycle audit row written, in order — the trail a dispute would be read from. */
  let auditTrail: { entityId: string; eventType: string; previousState: string | null; newState: string | null; remarks: string | null }[];
  /**
   * Hops the harness is told to refuse, keyed `id:TO_STATE`, standing in for the things that can
   * only go wrong mid-walk: another operator moving the same person, or the database going away.
   */
  let sabotage: Map<string, Error>;
  let identityOk: boolean;
  let identityGateMode: string;

  const seed = (id: string, lifecycleStatus: AssayerLifecycleStatus): string => {
    rows.set(id, { id, lifecycleStatus, version: 1, isActive: lifecycleStatus !== AssayerLifecycleStatus.ARCHIVED, displayName: `Person ${id}` });
    return id;
  };
  const stateOf = (id: string) => rows.get(id)?.lifecycleStatus;
  const auditFor = (id: string) => auditTrail.filter((e) => e.entityId === id);
  const transitionsFor = (id: string) => auditFor(id).filter((e) => e.eventType === 'ASSAYER_LIFECYCLE_TRANSITION');

  const mockAssayerRepo = {
    /**
     * The one read that matters for these tests. `isActive: true` in the predicate is honoured
     * because the production `findOne` carries it — that filter is why a walk ending in ARCHIVED
     * cannot be re-read by the ordinary reader, and `reachedState` exists to get round it.
     */
    findOne: jest.fn(async ({ where }: any) => {
      const row = rows.get(where.id);
      if (!row) return null;
      if (where.isActive === true && !row.isActive) return null;
      return { ...row };
    }),
    save: jest.fn(async (entity: any) => {
      const existing = rows.get(entity.id)!;
      rows.set(entity.id, {
        ...existing,
        lifecycleStatus: entity.lifecycleStatus,
        isActive: entity.isActive,
        version: existing.version + 1,
      });
      return { ...entity };
    }),
    create: jest.fn((x: any) => x),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    manager: { count: jest.fn().mockResolvedValue(0), query: jest.fn().mockResolvedValue([]) },
    metadata: { findColumnWithPropertyName: (name: string) => ({ propertyName: name, isNullable: true }) },
  };

  const inertRepo = () => ({
    create: jest.fn((x: any) => x),
    save: jest.fn(async (x: any) => x),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    delete: jest.fn(),
  });

  const mockActivityRepo = inertRepo();
  const mockAuditService = {
    recordEvent: jest.fn(async (dto: any) => {
      auditTrail.push({
        entityId: dto.entityId,
        eventType: dto.eventType,
        previousState: dto.previousState ?? null,
        newState: dto.newState ?? null,
        remarks: dto.remarks ?? null,
      });
    }),
    recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  /** The transaction manager `doTransitionLifecycle` locks and writes through. */
  const mockManager = {
    getRepository: jest.fn((entity: any) => {
      if (entity === AssayerEntity) return mockAssayerRepo;
      if (entity === AssayerActivityEntity) return mockActivityRepo;
      return inertRepo();
    }),
    query: jest.fn(async (_sql: string, params: any[]) => {
      const row = rows.get(params[0]);
      if (!row || !row.isActive) return [];
      return [{ lifecycle_status: row.lifecycleStatus, version: row.version }];
    }),
  };

  /**
   * A hop is one transaction: it either commits whole or leaves nothing behind. `sabotage` throws
   * BEFORE the action runs, which is what a lost compare-and-swap looks like from here — the hop
   * did not happen and the ones before it did.
   */
  const runHop = async (_key: any, id: any, _cmd: any, _from: any, to: any, _uid: any, _role: any, _roles: any, action: any) => {
    const rigged = sabotage.get(`${id}:${to}`);
    if (rigged) throw rigged;
    return action(mockManager);
  };
  const mockWorkflowEngine = { registerWorkflow: jest.fn(), executeCommand: jest.fn(runHop) };

  beforeEach(async () => {
    rows = new Map();
    auditTrail = [];
    sabotage = new Map();
    identityOk = true;
    identityGateMode = 'warn';

    const module = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: inertRepo() },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: inertRepo() },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: inertRepo() },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: mockActivityRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: mockWorkflowEngine },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: NotificationService, useValue: { notifyAssayer: jest.fn().mockResolvedValue({ inAppDelivered: true }) } },
        { provide: EmailProvider, useValue: { send: jest.fn().mockResolvedValue({ success: false }) } },
        { provide: SmsProvider, useValue: { send: jest.fn().mockResolvedValue(false) } },
        { provide: UnitOfWork, useValue: { run: jest.fn((work: any) => work(mockManager)) } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } as unknown as DataSource },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: RosterRecordsService,
          useValue: { identityStanding: jest.fn(async () => ({ ok: identityOk, verified: [], missing: identityOk ? [] : ['PAN_CARD'], rejected: [] })) },
        },
        { provide: PlatformSettingsService, useValue: { get: jest.fn(async () => identityGateMode) } },
      ],
    }).compile();

    service = module.get(AssayerService);
    jest.clearAllMocks();
    // `clearAllMocks` clears calls but keeps implementations, and one test below replaces this
    // one to simulate a hop that throws after committing. Re-seated per test so it cannot leak.
    mockWorkflowEngine.executeCommand.mockImplementation(runHop);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The defect itself
  // ───────────────────────────────────────────────────────────────────────────

  describe('the walk that used to commit a hop and report failure', () => {
    /**
     * INVITED → INACTIVE routes INVITED → DOCUMENT_VERIFICATION → INACTIVE. The first hop needs no
     * reason and the second does, so the old code committed hop one, was refused at hop two, and
     * answered `failed` for somebody now sitting in DOCUMENT_VERIFICATION.
     *
     * The missing reason was knowable before hop one. It is now checked against the whole path.
     */
    it('refuses INVITED → INACTIVE without a reason before anything moves', async () => {
      const id = seed('a1', AssayerLifecycleStatus.INVITED);

      const result = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.INACTIVE, 'op');

      expect(result.failed).toEqual([]);
      expect(result.partial).toEqual([]);
      expect(result.succeeded).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].current).toBe(AssayerLifecycleStatus.INVITED);
      // The refusal names the hop that needs the sentence, not the destination the operator picked.
      expect(result.skipped[0].reason).toMatch(/moved to inactive/i);
      expect(result.skipped[0].reason).toMatch(/Nothing was changed/);

      // And the database agrees with the response.
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.INVITED);
      expect(transitionsFor(id)).toHaveLength(0);
    });

    it('takes the same walk when the reason is supplied, and says which route it took', async () => {
      const id = seed('a2', AssayerLifecycleStatus.INVITED);

      const result = await service.bulkTransitionLifecycle(
        [id], AssayerLifecycleStatus.INACTIVE, 'op', 'Never replied to the invitation; file closed.',
      );

      expect(result.skipped).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.succeeded).toEqual([{
        id,
        from: AssayerLifecycleStatus.INVITED,
        to: AssayerLifecycleStatus.INACTIVE,
        via: [AssayerLifecycleStatus.DOCUMENT_VERIFICATION, AssayerLifecycleStatus.INACTIVE],
      }]);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.INACTIVE);
      // One audit row per hop, not one per batch — the intermediate state really was written.
      expect(transitionsFor(id).map((e) => e.newState)).toEqual([
        AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        AssayerLifecycleStatus.INACTIVE,
      ]);
    });

    /**
     * THE INVARIANT. Whatever else changes, a row whose state moved may never be reported as a
     * failure. Driven by sabotaging the LAST hop of a three-hop walk, which is the shape of a
     * concurrent transition landing between hops — the one class of refusal no rehearsal can
     * pre-empt.
     */
    it('never reports a moved row as failed — a hop that dies mid-walk is PARTIAL', async () => {
      const id = seed('a3', AssayerLifecycleStatus.INVITED);
      sabotage.set(`${id}:${AssayerLifecycleStatus.TRAINING}`, new Error(
        "This assayer changed while you were acting on it — they are now 'INACTIVE', not 'BACKGROUND_VERIFICATION'.",
      ));

      const result = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.ACTIVE, 'op');

      expect(result.failed).toEqual([]);
      expect(result.succeeded).toEqual([]);
      expect(result.partial).toHaveLength(1);
      const [row] = result.partial;
      expect(row.id).toBe(id);
      expect(row.from).toBe(AssayerLifecycleStatus.INVITED);
      expect(row.target).toBe(AssayerLifecycleStatus.ACTIVE);
      expect(row.via).toEqual([
        AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      ]);

      // `reached` is the DATABASE's answer, and the database is what an operator will go and look at.
      expect(row.reached).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
    });

    it('puts the abandonment on the audit trail, not only the hops that landed', async () => {
      const id = seed('a4', AssayerLifecycleStatus.INVITED);
      sabotage.set(`${id}:${AssayerLifecycleStatus.TRAINING}`, new Error('the database went away'));

      await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.ACTIVE, 'op');

      const abandoned = auditFor(id).filter((e) => e.eventType === 'ASSAYER_LIFECYCLE_WALK_ABANDONED');
      expect(abandoned).toHaveLength(1);
      // Six months later, "why is this person half way through onboarding" has an answer.
      expect(abandoned[0].remarks).toContain('INVITED → ACTIVE');
      expect(abandoned[0].remarks).toContain(`stopped at ${AssayerLifecycleStatus.BACKGROUND_VERIFICATION}`);
      expect(abandoned[0].newState).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
    });

    /**
     * The mirror of the same principle. `WorkflowEngine.executeCommand` runs `afterTransition`
     * AFTER its transaction commits, so the last hop can land and still throw. Bookkeeping alone
     * would call that `partial` for somebody standing exactly where the operator asked; the
     * database says otherwise and the database wins.
     */
    it('reports a walk that arrived as succeeded, even when its last hop threw after committing', async () => {
      const id = seed('a5', AssayerLifecycleStatus.INVITED);
      mockWorkflowEngine.executeCommand.mockImplementation(async (...args: any[]) => {
        const out = await (runHop as any)(...args);
        // Committed, then blew up on the way out — exactly the afterTransition hazard.
        if (args[4] === AssayerLifecycleStatus.BACKGROUND_VERIFICATION) throw new Error('afterTransition hook exploded');
        return out;
      });

      const result = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.BACKGROUND_VERIFICATION, 'op');

      expect(result.partial).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.succeeded).toHaveLength(1);
      expect(result.succeeded[0].to).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
      // `via` reports the hops this loop actually saw return — it does not claim the one it did not.
      expect(result.succeeded[0].via).toEqual([AssayerLifecycleStatus.DOCUMENT_VERIFICATION]);
    });

    /**
     * The other half of the invariant: `failed` has to keep meaning something. A row that never
     * moved at all — here because it cannot be loaded — is still a plain failure.
     */
    it('still reports a row that never moved as failed', async () => {
      const result = await service.bulkTransitionLifecycle(
        ['00000000-0000-4000-8000-000000000000'], AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'op',
      );

      expect(result.failed).toHaveLength(1);
      expect(result.partial).toEqual([]);
      expect(result.failed[0].reason).toMatch(/not found/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The rules the single-record path enforces, enforced here too
  // ───────────────────────────────────────────────────────────────────────────

  describe('the rules a bulk walk may not bypass', () => {
    /**
     * The reason gate is PER HOP and the rehearsal reads the whole path, so a destination that
     * needs no reason cannot smuggle a walk through states that do. `TRAINING → ARCHIVED` routes
     * via INACTIVE; both hops need one.
     */
    it('refuses a walk whose intermediate hop needs a reason, even when the destination is reached', async () => {
      const id = seed('b1', AssayerLifecycleStatus.TRAINING);

      const result = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.ARCHIVED, 'op');

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toMatch(/moved to inactive/i);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.TRAINING);
      expect(transitionsFor(id)).toHaveLength(0);
    });

    /** `NEVER_A_WAYPOINT`: the rehire edge exists but is not a corridor back into the workforce. */
    it('will not launder a departed person back to ACTIVE through the rehire edge', async () => {
      const id = seed('b2', AssayerLifecycleStatus.RESIGNED);

      const withoutReason = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.ACTIVE, 'op');
      const withReason = await service.bulkTransitionLifecycle(
        [id], AssayerLifecycleStatus.ACTIVE, 'op', 'They asked to come back.',
      );

      // Skipped for want of a PATH, not for want of a reason — supplying one changes nothing.
      for (const result of [withoutReason, withReason]) {
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].reason).toMatch(/No valid path/);
        expect(result.partial).toEqual([]);
      }
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.RESIGNED);
      expect(transitionsFor(id)).toHaveLength(0);
    });

    /**
     * The identity gate under `enforce`. `INVITED → ACTIVE` is four hops and the gate only bites
     * on the last one, so this was the most likely partial in production: three committed hops
     * and a queue of people parked in TRAINING.
     */
    it('refuses the whole onboarding walk when the identity gate would refuse its last hop', async () => {
      identityGateMode = 'enforce';
      identityOk = false;
      const id = seed('b3', AssayerLifecycleStatus.INVITED);

      const result = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.ACTIVE, 'op');

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toMatch(/cannot be activated yet/);
      expect(result.skipped[0].reason).toMatch(/Nothing was changed/);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.INVITED);
      expect(transitionsFor(id)).toHaveLength(0);
    });

    /**
     * …and only under enforce. `warn` is what ships, and pre-empting a refusal the funnel would
     * not make would refuse work the operator is entitled to do.
     */
    it('lets the same walk through when the gate is only warning', async () => {
      identityGateMode = 'warn';
      identityOk = false;
      const id = seed('b4', AssayerLifecycleStatus.INVITED);

      const result = await service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.ACTIVE, 'op');

      expect(result.succeeded).toHaveLength(1);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.ACTIVE);
    });

    /**
     * An over-long reason is a fact about the REQUEST, so it is refused as one — before any row
     * has been touched, exactly as the single-transition route refuses it. Reported per row it
     * would have failed every id in the batch after the first had already moved.
     */
    it('refuses an over-long reason for the whole request, having moved nobody', async () => {
      const id = seed('b5', AssayerLifecycleStatus.INVITED);

      await expect(
        service.bulkTransitionLifecycle([id], AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'op', 'x'.repeat(2001)),
      ).rejects.toThrow(/Keep it under 2000/);

      expect(stateOf(id)).toBe(AssayerLifecycleStatus.INVITED);
      expect(transitionsFor(id)).toHaveLength(0);
    });

    it('refuses a target that is not a lifecycle state at all', async () => {
      await expect(service.bulkTransitionLifecycle(['b6'], 'PROMOTED', 'op'))
        .rejects.toThrow(/Invalid target status/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Batches
  // ───────────────────────────────────────────────────────────────────────────

  describe('a batch of several people', () => {
    it('moves every row when every row can move', async () => {
      const ids = [
        seed('c1', AssayerLifecycleStatus.INVITED),
        seed('c2', AssayerLifecycleStatus.INVITED),
        seed('c3', AssayerLifecycleStatus.INVITED),
      ];

      const result = await service.bulkTransitionLifecycle(ids, AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'op');

      expect(result.succeeded.map((s) => s.id)).toEqual(ids);
      expect(result.skipped).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.partial).toEqual([]);
      for (const id of ids) expect(stateOf(id)).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    });

    it('moves nobody when nobody can move, and says so per row', async () => {
      const ids = [
        seed('c4', AssayerLifecycleStatus.ACTIVE),
        seed('c5', AssayerLifecycleStatus.ON_LEAVE),
      ];

      const result = await service.bulkTransitionLifecycle(ids, AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'op');

      expect(result.succeeded).toEqual([]);
      expect(result.skipped).toHaveLength(2);
      expect(stateOf(ids[0])).toBe(AssayerLifecycleStatus.ACTIVE);
      expect(stateOf(ids[1])).toBe(AssayerLifecycleStatus.ON_LEAVE);
    });

    /**
     * Per-row isolation, and each row's own answer true of that row. The sabotaged id is the
     * middle one deliberately: a loop that aborted on it would leave the third untouched and
     * unreported.
     */
    it('isolates rows — one bad id neither rolls back a good one nor stops the next', async () => {
      const good = seed('c6', AssayerLifecycleStatus.INVITED);
      const doomed = seed('c7', AssayerLifecycleStatus.INVITED);
      const alsoGood = seed('c8', AssayerLifecycleStatus.INVITED);
      const noPath = seed('c9', AssayerLifecycleStatus.ACTIVE);
      sabotage.set(`${doomed}:${AssayerLifecycleStatus.DOCUMENT_VERIFICATION}`, new Error('lost the race'));

      const result = await service.bulkTransitionLifecycle(
        [good, doomed, alsoGood, noPath], AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'op',
      );

      expect(result.succeeded.map((s) => s.id)).toEqual([good, alsoGood]);
      expect(result.failed.map((f) => f.id)).toEqual([doomed]);
      expect(result.skipped.map((s) => s.id)).toEqual([noPath]);
      expect(result.partial).toEqual([]);

      expect(stateOf(good)).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(stateOf(alsoGood)).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(stateOf(doomed)).toBe(AssayerLifecycleStatus.INVITED);
      expect(stateOf(noPath)).toBe(AssayerLifecycleStatus.ACTIVE);
    });

    /** A mixed batch where one row goes all the way and another stops part way. */
    it('reports one row succeeded and another partial in the same call', async () => {
      const clean = seed('c10', AssayerLifecycleStatus.INVITED);
      const stalls = seed('c11', AssayerLifecycleStatus.INVITED);
      sabotage.set(`${stalls}:${AssayerLifecycleStatus.BACKGROUND_VERIFICATION}`, new Error('lost the race'));

      const result = await service.bulkTransitionLifecycle(
        [clean, stalls], AssayerLifecycleStatus.TRAINING, 'op',
      );

      expect(result.succeeded.map((s) => s.id)).toEqual([clean]);
      expect(result.partial.map((p) => p.id)).toEqual([stalls]);
      expect(result.failed).toEqual([]);
      expect(stateOf(clean)).toBe(AssayerLifecycleStatus.TRAINING);
      expect(stateOf(stalls)).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(result.partial[0].reached).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    });

    /** The same id twice in one batch: the repeat is a no-op self-path, and says so. */
    it('transitions a duplicated id exactly once and reports the repeat as a no-op', async () => {
      const id = seed('c12', AssayerLifecycleStatus.INVITED);

      const result = await service.bulkTransitionLifecycle(
        [id, id], AssayerLifecycleStatus.DOCUMENT_VERIFICATION, 'op',
      );

      expect(result.succeeded).toHaveLength(2);
      expect(result.succeeded[0].via).toEqual([AssayerLifecycleStatus.DOCUMENT_VERIFICATION]);
      // `via: []` is the honest account of the second: it reports arrival, not a move.
      expect(result.succeeded[1].via).toEqual([]);
      expect(result.succeeded[1].from).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
      expect(transitionsFor(id)).toHaveLength(1);
      expect(stateOf(id)).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    });

    /** The same request sent twice: the second is a no-op that writes nothing. */
    it('is idempotent on a repeated submission — the second call writes no transition', async () => {
      const ids = [seed('c13', AssayerLifecycleStatus.INVITED), seed('c14', AssayerLifecycleStatus.INVITED)];

      const first = await service.bulkTransitionLifecycle(ids, AssayerLifecycleStatus.TRAINING, 'op');
      const auditAfterFirst = ids.flatMap((id) => transitionsFor(id)).length;
      const second = await service.bulkTransitionLifecycle(ids, AssayerLifecycleStatus.TRAINING, 'op');

      expect(first.succeeded).toHaveLength(2);
      expect(first.succeeded[0].via).toHaveLength(3);
      expect(second.succeeded).toHaveLength(2);
      expect(second.succeeded.every((s) => s.via.length === 0)).toBe(true);
      expect(ids.flatMap((id) => transitionsFor(id))).toHaveLength(auditAfterFirst);
      for (const id of ids) expect(stateOf(id)).toBe(AssayerLifecycleStatus.TRAINING);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The response and the database, held against each other
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The property the whole exercise is about, asserted over every bucket rather than case by case:
   * whatever the response says about a row, the database says the same thing.
   */
  it('never contradicts the database, whichever bucket a row lands in', async () => {
    const moved = seed('d1', AssayerLifecycleStatus.INVITED);
    const stalled = seed('d2', AssayerLifecycleStatus.INVITED);
    const refused = seed('d3', AssayerLifecycleStatus.ACTIVE);
    const broken = seed('d4', AssayerLifecycleStatus.INVITED);
    sabotage.set(`${stalled}:${AssayerLifecycleStatus.BACKGROUND_VERIFICATION}`, new Error('lost the race'));
    sabotage.set(`${broken}:${AssayerLifecycleStatus.DOCUMENT_VERIFICATION}`, new Error('lost the race'));

    const before = new Map([...rows].map(([id, r]) => [id, r.lifecycleStatus]));
    const result = await service.bulkTransitionLifecycle(
      [moved, stalled, refused, broken], AssayerLifecycleStatus.TRAINING, 'op',
    );

    for (const row of result.succeeded) expect(stateOf(row.id)).toBe(row.to);
    for (const row of result.partial) {
      expect(stateOf(row.id)).toBe(row.reached);
      expect(row.reached).not.toBe(row.target);
      expect(row.reached).not.toBe(row.from);
    }
    // The two "nothing happened" buckets have to mean it.
    for (const row of result.skipped) expect(stateOf(row.id)).toBe(before.get(row.id));
    for (const row of result.failed) expect(stateOf(row.id)).toBe(before.get(row.id));

    // Every id is accounted for exactly once.
    const reported = [...result.succeeded, ...result.partial, ...result.skipped, ...result.failed].map((r) => r.id);
    expect(reported.sort()).toEqual([moved, stalled, refused, broken].sort());
  });
});
