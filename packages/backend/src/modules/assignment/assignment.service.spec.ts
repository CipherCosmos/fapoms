import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { AssignmentService } from './assignment.service';
// Controller-level pins for the negotiation refusal (the gate lives in the controller, the way
// the fee self-dealing guard does), and the limits kill-switch it pairs with.
import { AssignmentController } from './assignment.controller';
import { PlatformSettingsController } from '../../infrastructure/settings/platform-settings.controller';
import { AssignmentEntity } from './assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { AssignmentRefreshPushService } from '../notifications/assignment-refresh-push.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentStatus, ProjectBranchStatus, EventCategory, Priority, businessTodayDateKey, BypassableRule, AssayerStatus, AssayerLifecycleStatus } from '@fapoms/shared';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssayerService } from '../assayer/assayer.service';
import { LocationTrailService } from '../assayer/location-trail.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { DAY_TRAVEL_QUERY_MARKER, DayTravelService } from './assignment-day-travel';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { OperationsInboxService } from './operations-inbox.service';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';
import { ValidationService } from '../validation/validation.service';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { DocumentService } from '../document/document.service';
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { AssignmentTargetEligibilityService } from './assignment-target-eligibility.policy';

describe('AssignmentService', () => {
  let service: AssignmentService;
  let assignmentRepo: Repository<AssignmentEntity>;
  let holidayService: HolidayService;
  let auditService: AuditService;

  const mockAssignmentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    // The list runs the page and its total in parallel; `count` is the total half.
    count: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockAssayerRepo = {
    findOne: jest.fn(),
  };

  const mockProjectService = {
    initiateBranchPlanning: jest.fn(),
    confirmBranchAssignment: jest.fn(),
    scheduleBranchAudit: jest.fn(),
    completeBranchAudit: jest.fn(),
    closeBranchProject: jest.fn(),
  };

  const mockProjectQueryService = {
    findProjectBranchById: mockProjectBranchRepo.findOne,
  };

  const mockAssayerService = {
    findOne: mockAssayerRepo.findOne,
    updateAssayerStats: jest.fn(),
    // Cached counters are refreshed off the critical path of a transition — the operator's click
    // must not wait on statistics. Mocked as a no-op because nothing in these tests reads them.
    scheduleStatsRefresh: jest.fn(),
    // Accepting work turns location sharing on: the movement trail is what will confirm the travel
    // being paid for, so the obligation starts with the job.
    enableLiveTrackingForActiveWork: jest.fn().mockResolvedValue(undefined),
    // The other half of that promise: sharing stops once the job ends and no other committed
    // work remains.
    disableLiveTrackingWhenWorkEnds: jest.fn().mockResolvedValue(undefined),
    getActiveCommercialProfile: jest.fn().mockResolvedValue({ baseFee: 1500 }),
  };

  /** The movement trail a check-in anchors. Asserted on in the check-in tests below. */
  const mockLocationTrail = {
    record: jest.fn().mockResolvedValue(undefined),
    ingest: jest.fn().mockResolvedValue({ accepted: 1, duplicates: 0, rejected: [] }),
    assessAssignmentTravel: jest.fn().mockResolvedValue(null),
    fixesBetween: jest.fn().mockResolvedValue([]),
  };

  // Unlabelled by default — a route from something older than the labelled provider — which
  // the service must record as an estimate. Individual tests override with a labelled route.
  const mockRoutingService = { calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 5, durationMinutes: 10 }) };

  const mockFeePolicyService = {
            quote: jest.fn().mockResolvedValue({
              baseFee: 1200, branchCount: 1, baseComponent: 1200,
              distanceKm: 0, chargeableKm: 0, travelFee: 0, total: 1200,
              usedFallbackBaseFee: false,
              rates: { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true },
            }),
            getRates: jest.fn().mockResolvedValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true }),
            ratesFromConfiguration: jest.fn().mockReturnValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true }),
            resolveBaseFee: jest.fn().mockResolvedValue({ baseFee: 1200, usedFallback: false }),
            calculateTravelFee: jest.fn().mockReturnValue({ chargeableKm: 0, travelFee: 0 }),
            resolveClientIdForProject: jest.fn().mockResolvedValue(null),
  };

  const mockHolidayService = {
    isHoliday: jest.fn(),
  };

  const mockNotificationDispatch = {
  emit: jest.fn().mockResolvedValue({ groupKey: 'g', created: 1, suppressed: 0, recipients: { userIds: [], assayerIds: [] } }),
  emitSafe: jest.fn(),
  markRead: jest.fn(),
};

const mockNotificationService = {
    create: jest.fn().mockImplementation(async (dto) => ({ id: 'notif-123', ...dto })),
  };

  const mockPushNotificationService = {
    sendToUser: jest.fn().mockResolvedValue(undefined),
  };

  const mockAuditService = {
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  const mockDomainEventPublisher = {
    publish: jest.fn(),
  };

  const mockUserRepoViaDataSource = {
    findOne: jest.fn(),
  };

  /**
   * The ACCEPTED transition writes the calendar dispatch packet through
   * `dataSource.getRepository(ScheduleEntity)`. It needs its own double: the shared user-repo one
   * returns a bare `undefined` from findOne, and the service chains `.catch()` onto that call.
   *
   * Keyed by the entity class now, not the string `'schedules'` — the write moved to the typed
   * repository when it was routed through the availability gate, so it also needs `create`.
   */
  const mockScheduleRepoViaDataSource = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((arg: any) => arg),
    save: jest.fn((arg: any) => Promise.resolve({ id: 'sched-1', ...arg })),
  };

  const mockDataSource = {
    transaction: jest.fn((cb) => cb({
      // The counter-offer CAS re-reads the assignment FOR UPDATE inside the transaction; serve it
      // from whatever the repository's findOne last resolved (the object the test set up), so the
      // locked re-read sees the same row.
      findOne: jest.fn((entity: any, _opts?: any) => {
        if (entity === AssayerEntity || entity?.name === 'AssayerEntity') {
          return Promise.resolve({
            id: 'assayer-1',
            status: AssayerStatus.ACTIVE,
            lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
            isActive: true,
          });
        }
        return mockAssignmentRepo.findOne();
      }),
      save: jest.fn((arg) => Promise.resolve(arg)),
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn((_opts?: any) => Promise.resolve({
          id: 'assayer-1',
          status: AssayerStatus.ACTIVE,
          lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
          isActive: true,
        })),
        save: jest.fn((arg) => Promise.resolve(arg)),
        create: jest.fn((arg) => arg),
      }),
    })),
    getRepository: jest.fn((target: any) =>
      target === 'schedules' || target === ScheduleEntity ? mockScheduleRepoViaDataSource : mockUserRepoViaDataSource,
    ),
    // Only the CLIENT_ELIGIBILITY bypass-attribution test below sets a project branch with a
    // real clientId, which is what makes create() reach this raw empanelment lookup at all —
    // every other test's `project: {}` skips the whole eligibility block, `query` unused.
    query: jest.fn().mockResolvedValue([]),
  };

  // The real UnitOfWork releases emitted events through the publisher after commit; this
  // double runs the work with a manager and routes emit() to the same publisher mock, so the
  // domain-event assertions below exercise the events the service now emits from inside its
  // transaction rather than publishing after it.
  /**
   * The schedule repository reached through the *transaction's* manager. Stable across calls so
   * a test can assert what a transition did to the calendar entry — completing it, or retiring
   * it when the job is cancelled.
   */
  const mockScheduleRepoInTx = {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn((arg: any) => Promise.resolve(arg)),
    create: jest.fn((arg: any) => arg),
  };

  /**
   * The last assignment-shaped entity `manager.save()` was handed, so the read-back below can
   * answer from it. The service saves through the transaction's manager, not the repository.
   */
  let lastSavedInTx: any = null;


  const mockUnitOfWork = {
    run: jest.fn(async (work: any) =>
      work(
        {
          save: jest.fn((arg: any) => {
            if (arg?.assayerId !== undefined || arg?.status !== undefined) lastSavedInTx = arg;
            return Promise.resolve(arg);
          }),
          // The transition engine re-reads the row when a command turns out to be already
          // achieved, so it can answer with committed state rather than its own scratch object.
          findOne: jest.fn(async (_target: any, opts: any) =>
            mockAssignmentRepo.findOne(opts)),
          /**
           * The assignment-number sequence returns a fixed value so the number is deterministic.
           *
           * The transition path's `SELECT … FOR UPDATE` compare-and-swap re-reads the row inside
           * the transaction. It is served from whatever the repository's `findOne` last resolved
           * for that id — the same object the service holds, which the state machine has already
           * advanced to the target before the transaction opens. So this fake reports the row as
           * already at the target where a real database would report the prior status.
           *
           * That inaccuracy is why the already-achieved shortcut in the service keys on the
           * ENTITY VERSION rather than on the status alone: a rival that genuinely got there first
           * has bumped the version, and this fake has not. See the comment on that guard.
           */
          query: jest.fn(async (sql: string, params?: any[]) => {
            if (/nextval\('assignment_number_seq'\)/.test(sql)) return [{ n: '42' }];
            if (/FOR UPDATE/.test(sql)) {
              const results = mockAssignmentRepo.findOne.mock.results;
              let fallback: any = null;
              for (let i = results.length - 1; i >= 0; i--) {
                const v = await Promise.resolve(results[i]?.value).catch(() => null);
                if (!v) continue;
                if (params?.[0] != null && v.id === params[0]) return [{ status: v.status, entity_version: 1 }];
                fallback = fallback ?? v;
              }
              return fallback ? [{ status: fallback.status, entity_version: 1 }] : [];
            }
            /**
             * The read-back `create()` performs after its save, to confirm the row is really
             * there and really belongs to the assayer it was written for.
             *
             * Answered from the entity the repository just saved, so the fake behaves like a
             * database rather than like a promise that resolves. A stub returning `[]` here would
             * make every create look like a write that silently did not take — which is exactly
             * what the production check is for.
             */
            if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) {
              if (!lastSavedInTx) return [];
              /**
               * `assayerId` falls back to the argument the service handed
               * `assignmentRepository.create()`, because most fixtures in this file stub that
               * method with a small literal that omits it. The argument is what the service asked
               * to persist, so answering from it is what a database would do — and it keeps the
               * check honest: a test that made the service ask for the wrong assayer would still
               * fail here.
               */
              const asked = mockAssignmentRepo.create.mock.calls.at(-1)?.[0] ?? {};
              return [{
                assayer_id: lastSavedInTx.assayerId ?? lastSavedInTx.assayer?.id ?? asked.assayerId ?? null,
                entity_version: lastSavedInTx.entityVersion ?? 1,
                status: lastSavedInTx.status,
              }];
            }
            return [];
          }),
          getRepository: jest.fn((target: any) =>
            target === ScheduleEntity
              ? mockScheduleRepoInTx
              : {
                  findOne: jest.fn(),
                  save: jest.fn((arg: any) => Promise.resolve(arg)),
                  create: jest.fn((arg: any) => arg),
                },
          ),
        },
        (event: string, payload: any) =>
          mockDomainEventPublisher.publish(event, { ...payload, timestamp: new Date() }),
      ),
    ),
  };

  // Named (not an inline literal) so an individual test can override one method — see the
  // CLIENT_ELIGIBILITY bypass-attribution test below — without touching every other test's
  // "nothing suspended" baseline, which `beforeEach` restores here on every run.
  const mockRuleBypass = {
    isBypassedSync: jest.fn().mockReturnValue(false),
    isBypassed: jest.fn().mockResolvedValue(false),
    noteBypass: jest.fn(),
  };

  const mockConstraintEvaluator = {
    checkLeaves: jest.fn().mockReturnValue({ passed: true }),
    checkProjectTimeline: jest.fn().mockReturnValue({ passed: true }),
    checkHoliday: jest.fn().mockResolvedValue({ passed: true }),
    checkDateAvailability: jest.fn().mockResolvedValue({ passed: true }),
    checkDistancePolicy: jest.fn().mockReturnValue({ passed: true }),
    checkSkillsAndCertifications: jest.fn().mockReturnValue({ passed: true }),
  };

  /** The silent "your jobs changed" push (owner decision 2026-09-24). */
  const mockRefreshPush = { assignmentChanged: jest.fn() };

  /** Travel once per assayer per day, re-decided after a day changes (assignment-day-travel.ts). */
  const mockDayTravel = { rebalance: jest.fn(), rebalanceMany: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: AssignmentRefreshPushService, useValue: mockRefreshPush },
        { provide: DayTravelService, useValue: mockDayTravel },
        {
          // Rules are enforced unless an administrator suspends them — see
          // modules/platform/rule-bypass. Nothing is suspended here by default, which is the
          // state most of these tests are actually about; the bypass-attribution test below
          // overrides `isBypassedSync` for its own run only.
          provide: RuleBypassService,
          useValue: mockRuleBypass,
        },
        {
          // Nothing configured in tests, so every lookup falls through to the caller's fallback
          // — which is the shipped default. That is deliberately the state these tests assert
          // against: the geofence and negotiation cap behave as delivered.
          provide: PlatformSettingsService,
          useValue: {
            get: jest.fn(async () => null),
            getNumber: jest.fn(async (_k: string, fb?: number) => fb as number),
            onChange: jest.fn(),
          },
        },
        AssignmentService,
        {
          provide: DocumentService,
          useValue: {
            findByProjectBranch: jest.fn().mockResolvedValue([]),
            findDispatchedForAssayer: jest.fn().mockResolvedValue({ documents: [], readiness: {} }),
            dispatchDocument: jest.fn(),
            notifyAcceptedAssayerOfDispatchedPacket: jest.fn().mockResolvedValue(0),
          },
        },
        { provide: FeePolicyService, useValue: mockFeePolicyService },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: ProjectService, useValue: mockProjectService },
        { provide: AssayerService, useValue: mockAssayerService },
        { provide: LocationTrailService, useValue: mockLocationTrail },
        { provide: HolidayService, useValue: mockHolidayService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: NotificationDispatchService, useValue: mockNotificationDispatch },
        { provide: PushNotificationService, useValue: mockPushNotificationService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
        { provide: DataSource, useValue: mockDataSource },
        { provide: UnitOfWork, useValue: mockUnitOfWork },
        // The dashboard rollup is cached; `wrap` here always runs the loader, so every existing
        // assertion still exercises the real query path rather than a cache hit.
        {
          provide: CacheService,
          useValue: { wrap: jest.fn((_k: string, _ttl: number, load: () => unknown) => load()) },
        },
        { provide: ConstraintEvaluator, useValue: mockConstraintEvaluator },
        { provide: OperationsInboxService, useValue: { resolveChannels: jest.fn().mockResolvedValue(new Map()) } },
        { provide: RoutingService, useValue: mockRoutingService },
        { provide: ValidationService, useValue: { createAssessment: jest.fn().mockResolvedValue({}) } },
        // Only reached by the owner-decision `reopen` path (billing.service.spec.ts covers
        // voidPayable itself) — a stub is enough for every other test in this suite.
        /**
         * The real policy, not a stub. It is the object both write paths consult about client
         * eligibility, and this suite has tests — the CLIENT_ELIGIBILITY bypass attribution
         * below, the override-reason rules — that are *about* that decision. Stubbing it here
         * would leave those tests asserting against a mock's opinion instead of the rule. It is
         * given the same `mockDataSource`, settings and rule-bypass mocks the service itself
         * uses, so a test that arranges an empanelment row arranges it once for both.
         */
        AssignmentTargetEligibilityService,
        { provide: BillingEngineService, useValue: { voidPayable: jest.fn() } },
      ],
    }).compile();

    service = module.get<AssignmentService>(AssignmentService);
    assignmentRepo = module.get<Repository<AssignmentEntity>>(getRepositoryToken(AssignmentEntity));
    holidayService = module.get<HolidayService>(HolidayService);
    auditService = module.get<AuditService>(AuditService);

    jest.clearAllMocks();
  });

  describe('create', () => {
    const validDto = {
      projectBranchId: 'pb-1',
      assayerId: 'as-1',
      proposedFee: 500,
      scheduledDate: '2026-08-01',
    };

    it('should throw NotFoundException if project branch does not exist', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue(null);
      await expect(service.create(validDto, 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if assayer does not exist', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', branch: { state: 'MH' }, project: {} });
      mockAssayerRepo.findOne.mockResolvedValue(null);
      await expect(service.create(validDto, 'user-1')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if assayer lacks required skills', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', branch: { state: 'MH' },
        project: { requiredSkills: ['Expert Appraiser'] },
      });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: ['Junior Valuer'] });
      mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({
        passed: false, reason: 'Assayer lacks required skills',
      });
      await expect(service.create(validDto, 'user-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if existing active assignment exists', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', branch: { state: 'MH' }, project: {} });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: [], certifications: [] });
      mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({ passed: true });
      mockAssignmentRepo.findOne.mockResolvedValue({ id: 'existing', status: AssignmentStatus.ACCEPTED });
      await expect(service.create(validDto, 'user-1')).rejects.toThrow(ConflictException);
    });

    it('numbers a new assignment from the database sequence, six digits, never a random suffix', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', projectId: 'p-1', branch: { name: 'Test', state: 'MH' }, project: {},
      });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: [], certifications: [] });
      mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({ passed: true });
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      // create() returns the object it is given, so the number the service assigns inside the
      // transaction is the one we read back.
      mockAssignmentRepo.create.mockImplementation((arg: any) => ({ id: 'asn-new', ...arg }));

      const result = await service.create(validDto, 'user-1');
      const year = new Date().getFullYear();
      expect(result.assignmentNumber).toBe(`ASN-${year}-000042`);
      // Legacy numbers were four random digits; the two families must not share a width.
      expect(result.assignmentNumber).toMatch(/^ASN-\d{4}-\d{6}$/);
    });

    it('should create assignment in PENDING status', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', projectId: 'p-1', branch: { name: 'Test', state: 'MH' }, project: {},
      });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', skills: [], certifications: [] });
      mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({ passed: true });
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      const created = {
        id: 'asn-1', assignmentNumber: 'ASN-2026-1',
        status: AssignmentStatus.PENDING, proposedFee: 500,
      };
      mockAssignmentRepo.create.mockReturnValue(created);
      mockAssignmentRepo.save.mockResolvedValue(created);

      const result = await service.create(validDto, 'user-1');
      expect(result.status).toBe(AssignmentStatus.PENDING);
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });

    /**
     * Found live 2026-09-04: an active CLIENT_ELIGIBILITY bypass let a non-empanelled assayer be
     * assigned with no override reason at all, but the only trace was an anonymous, window-level
     * audit row naming the assayer — nothing on the assignment's own history. This proves the fix:
     * `noteBypass` is called with `entityType: 'ASSIGNMENT'` and THIS assignment's own id, once it
     * exists, matching the sibling `CHECK_IN_SCHEDULED_DAY`/`CHECK_IN_GEOFENCE` calls elsewhere in
     * this same file.
     */
    it('attributes a CLIENT_ELIGIBILITY bypass to the specific assignment it let through, not an anonymous window row', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', projectId: 'p-1', branch: { name: 'Test Branch', state: 'MH' },
        project: { clientId: 'client-1', client: { clientCode: 'CL1', restrictedAssayers: [] } },
      });
      mockAssayerRepo.findOne.mockResolvedValue({
        id: 'as-1', displayName: 'Test Assayer', skills: [], certifications: [],
      });
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      const created = { id: 'asn-bypass-1', assignmentNumber: 'ASN-2026-1', status: AssignmentStatus.PENDING };
      mockAssignmentRepo.create.mockReturnValue(created);
      mockAssignmentRepo.save.mockResolvedValue(created);
      // No empanelment row at all for (assayer, client) — the "not empanelled" branch (the
      // shared default already resolves to [], set explicitly here for this test's own clarity).
      mockDataSource.query.mockResolvedValueOnce([]);
      // Once only: this test's sole call to isBypassedSync, reverting to the shared
      // "nothing suspended" default for every other test in this file afterward.
      mockRuleBypass.isBypassedSync.mockReturnValueOnce(true);

      // No overrideReason on the dto — the bypass must be sufficient on its own.
      const result = await service.create(validDto, 'user-1');

      expect(result.id).toBe('asn-bypass-1');
      expect(mockRuleBypass.noteBypass).toHaveBeenCalledWith(
        BypassableRule.CLIENT_ELIGIBILITY,
        expect.objectContaining({
          entityType: 'ASSIGNMENT',
          entityId: 'asn-bypass-1',
          userId: 'user-1',
          detail: expect.stringContaining('Test Assayer'),
        }),
      );
    });
  });

  /**
   * "Assign anyway" now waives what it says it waives.
   *
   * Six of the seven blocking checks used to throw unconditionally while a seventh consulted
   * `overrideReason` — so the planning panel offered the button, the operator typed a
   * justification, and a rule that had never read the field refused them. The panel even suggested
   * the wording: its prompt for a skills exclusion was "Skill or certification requirement waived
   * by ops", for an action the server would always refuse.
   */
  /**
   * The phone channel. `acceptOnBehalf` says the agreement already happened out loud, so the
   * assignment is confirmed as it is raised rather than left as an offer the assayer must accept
   * in the app — where it would sit until they opened it, and be auto-declined if the response
   * SLA lapsed first (autoDeclineExpiredOffers).
   */
  describe('create with acceptOnBehalf — the desk confirms for the assayer', () => {
    const dto = {
      projectBranchId: 'pb-1',
      assayerId: 'as-1',
      proposedFee: 500,
      scheduledDate: '2026-08-01',
      acceptOnBehalf: true,
    };

    /** Wires create() and the acceptance that follows it onto the same assignment row. */
    const arrange = (overrides: Record<string, any> = {}) => {
      const projectBranch = { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION, isActive: true };
      const assignment: any = {
        id: 'asn-1',
        assignmentNumber: 'ASN-2026-1',
        assayerId: 'as-1',
        status: AssignmentStatus.PENDING,
        proposedFee: 500,
        agreedFee: null,
        scheduledDate: new Date('2026-08-01'),
        autoSchedule: true,
        projectBranch,
        ...overrides,
      };
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', projectId: 'p-1', branch: { name: 'Thrissur Main', state: 'KL' }, project: {},
      });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-1', displayName: 'A Kumar', skills: [], certifications: [] });
      mockConstraintEvaluator.checkSkillsAndCertifications.mockReturnValue({ passed: true });
      // Keyed on `where.id` so the two pre-flight lookups in create() (existing assignment for
      // the branch, and same-day travel) stay empty while the acceptance's findOne(id) resolves.
      // A fresh copy each time, as TypeORM gives: the row create() returned and the row the
      // transition loads are separate objects, so a failed transition cannot appear to have
      // mutated the one already handed back.
      mockAssignmentRepo.findOne.mockImplementation(async (opts: any) =>
        opts?.where?.id ? { ...assignment, projectBranch: assignment.projectBranch } : null,
      );
      mockAssignmentRepo.create.mockReturnValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      return { assignment, projectBranch };
    };

    it('returns the assignment already ACCEPTED, with the agreed fee settled', async () => {
      arrange();

      const result = await service.create(dto, 'user-1');

      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(result.agreedFee).toBe(500);
    });

    it('confirms the branch too, so the queue does not still show it awaiting a reply', async () => {
      const { projectBranch } = arrange();

      await service.create(dto, 'user-1');

      expect(projectBranch.status).toBe(ProjectBranchStatus.ASSIGNMENT_CONFIRMED);
    });

    it('records the acceptance against the operations user, not the assayer', async () => {
      arrange();

      await service.create(dto, 'user-1');

      // Who committed the assayer stays answerable: an ACCEPTED transition performed by user-1.
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'ASSIGNMENT_ACCEPTED',
          previousState: AssignmentStatus.PENDING,
          newState: AssignmentStatus.ACCEPTED,
          userId: 'user-1',
        }),
      );
    });

    it('sends one accurate notification instead of the offer/accept pair', async () => {
      arrange();

      await service.create(dto, 'user-1');

      const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
      // "Please accept or decline" would be false — it is already accepted. And telling ops the
      // assayer accepted it would credit the app for what a colleague did by phone.
      expect(types).not.toContain('ASSIGNMENT_OFFERED');
      expect(types).not.toContain('ASSIGNMENT_ACCEPTED');
      expect(types).toContain('ASSIGNMENT_DESK_CONFIRMED');
    });

    it('leaves a live PENDING offer, and says so, when the confirmation cannot be applied', async () => {
      // ProjectBranchStateMachine.confirmAssignment refuses an inactive branch link.
      arrange({ projectBranch: { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION, isActive: false } });

      const result = await service.create(dto, 'user-1');

      // The assignment itself committed — reporting it as confirmed would be the exact failure
      // this feature exists to prevent, so it degrades to the offer flow rather than to a lie.
      expect(result.status).toBe(AssignmentStatus.PENDING);
      const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
      expect(types).toContain('ASSIGNMENT_OFFERED');
      expect(types).not.toContain('ASSIGNMENT_DESK_CONFIRMED');
    });

    it('still leaves an offer when the flag is absent — the default is unchanged', async () => {
      arrange();

      const result = await service.create({ ...dto, acceptOnBehalf: undefined }, 'user-1');

      expect(result.status).toBe(AssignmentStatus.PENDING);
      const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
      expect(types).toContain('ASSIGNMENT_OFFERED');
    });
  });

  describe('acceptOffer', () => {
    it('should accept and update project branch to ASSIGNMENT_CONFIRMED', async () => {
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.PENDING, agreedFee: null,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION, isActive: true },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const result = await service.acceptOffer('asn-1', 'user-1', 2000);
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(result.agreedFee).toBe(2000);
      // A packet already dispatched to the branch is announced to whoever just accepted.
      const docs = (service as any).documentService;
      expect(docs.notifyAcceptedAssayerOfDispatchedPacket).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'asn-1' }), 'user-1',
      );
      expect(assignment.projectBranch.status).toBe(ProjectBranchStatus.ASSIGNMENT_CONFIRMED);
      // Confirming via the real ProjectBranchStateMachine (not a raw status mutation) must
      // also publish the domain event so real-time subscribers get notified.
      expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith(
        'ProjectBranchAssignmentConfirmedEvent',
        expect.objectContaining({ aggregateId: 'pb-1' }),
      );
    });
  });

  /**
   * `completion_date` is a `date` column, not a timestamp. Writing `new Date()` into it lets the
   * driver serialise the value under UTC, so a completion recorded between 00:00 and 05:30 IST
   * — before UTC has rolled to the same calendar day — lands one day early. `businessTodayDateKey`
   * is the IST-anchored helper the rest of the codebase already uses for exactly this column type
   * (see `receivedDate` in billing-engine.service.ts).
   */
  describe('completeAssignment — completion date is IST calendar day, not UTC-shifted', () => {
    const checkedIn = () => ({
      id: 'asn-1', status: AssignmentStatus.CHECKED_IN, checkedInAt: new Date('2026-08-20T09:00:00Z'),
      // A complete attendance record, so these cases stay about the completion DATE rather than
      // tripping the departure rule — that rule has its own tests.
      checkedOutAt: new Date('2026-08-20T13:30:00Z'),
      completionDate: null, assayerId: 'assayer-1',
    });

    it('writes businessTodayDateKey() — a string, never a Date instance', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(checkedIn());
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await service.completeAssignment('asn-1', 'user-1');

      // The mutation this proves: `assignment.completionDate = new Date();` also "succeeds" and
      // "looks like a date", so a loose assertion (`toBeTruthy()`, `toBeDefined()`) would not
      // catch reverting the fix. A Date instance fails both of these; only the string key passes.
      expect(typeof result.completionDate).toBe('string');
      expect(result.completionDate).toBe(businessTodayDateKey());
    });

    it('does not silently drift to the previous UTC day when it is already past midnight IST', async () => {
      // 2026-08-19T20:00:00Z is 2026-08-20T01:30 IST — after midnight IST, still the previous
      // calendar day in UTC. `new Date().toISOString().slice(0, 10)` here reads '2026-08-19';
      // the correct business day is '2026-08-20'.
      jest.useFakeTimers().setSystemTime(new Date('2026-08-19T20:00:00Z'));
      try {
        mockAssignmentRepo.findOne.mockResolvedValue(checkedIn());
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

        const result = await service.completeAssignment('asn-1', 'user-1');

        expect(result.completionDate).toBe('2026-08-20');
        expect(result.completionDate).not.toBe('2026-08-19');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * Owner decisions 2026-09-24 — E8 (leave), E9 (no silent move of a live offer), completion
   * notices, and the E11 date-change key.
   */
  describe('owner decisions 2026-09-24', () => {
    const pendingOn = (day: string, over: any = {}) => ({
      id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.PENDING, assayerId: 'assayer-1',
      scheduledDate: day, agreedFee: null,
      projectBranch: { id: 'pb-1', projectId: 'p-1', status: ProjectBranchStatus.PLANNING, isActive: true, branch: { name: 'Kochi', state: 'KL' } },
      ...over,
    });
    const assayerOnLeave = (from: string, to: string) => ({
      id: 'assayer-1', displayName: 'Anu', status: AssayerStatus.ACTIVE, isActive: true,
      leaves: [{ startDate: from, endDate: to }],
    });
    const codeOf = (e: any) => e?.getResponse?.()?.code ?? e?.code;

    it('E8: nobody can accept a job dated inside the assayer\'s leave — refused with ASSAYER_ON_LEAVE, nothing written', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(pendingOn('2026-10-05'));
      mockAssayerRepo.findOne.mockResolvedValue(assayerOnLeave('2026-10-04', '2026-10-06'));

      let thrown: any;
      try { await service.acceptOffer('asn-1', 'ops-1'); } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect(codeOf(thrown)).toBe('ASSAYER_ON_LEAVE');
      expect(mockUnitOfWork.run).not.toHaveBeenCalled();
    });

    it('E8: being on leave today does not stop accepting a job for another day', async () => {
      const today = businessTodayDateKey();
      mockAssignmentRepo.findOne.mockResolvedValue(pendingOn('2099-01-10'));
      mockAssayerRepo.findOne.mockResolvedValue(assayerOnLeave(today, today));
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await service.acceptOffer('asn-1', 'assayer-1');
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
    });

    it('E8: an administrator\'s ASSAYER_LEAVE bypass window lets it through, and is noted', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(pendingOn('2026-10-05'));
      mockAssayerRepo.findOne.mockResolvedValue(assayerOnLeave('2026-10-04', '2026-10-06'));
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockRuleBypass.isBypassed.mockResolvedValueOnce(true);

      const result = await service.acceptOffer('asn-1', 'ops-1');
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(mockRuleBypass.noteBypass).toHaveBeenCalledWith('ASSAYER_LEAVE', expect.objectContaining({ entityId: 'asn-1' }));
    });

    it('E8: a date the desk names while accepting is checked for leave too', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(pendingOn('2026-10-01'));
      mockAssayerRepo.findOne.mockResolvedValue(assayerOnLeave('2026-10-04', '2026-10-06'));

      let thrown: any;
      try { await service.acceptOffer('asn-1', 'ops-1', undefined, undefined, { scheduledDate: '2026-10-05' }); } catch (e) { thrown = e; }
      expect(codeOf(thrown)).toBe('ASSAYER_ON_LEAVE');
    });

    it('E8: a date the desk names while accepting must be workable — refused with ACCEPT_DATE_UNAVAILABLE', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(pendingOn('2026-10-01'));
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'assayer-1', status: AssayerStatus.ACTIVE, isActive: true, leaves: [] });
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValueOnce({ passed: false, reason: 'Holiday Conflict: 2026-10-02 is Gandhi Jayanti.' });

      let thrown: any;
      try { await service.acceptOffer('asn-1', 'ops-1', undefined, undefined, { scheduledDate: '2026-10-02' }); } catch (e) { thrown = e; }

      expect(codeOf(thrown)).toBe('ACCEPT_DATE_UNAVAILABLE');
      expect(thrown.message).toMatch(/Gandhi Jayanti/);
      expect(mockConstraintEvaluator.checkDateAvailability).toHaveBeenCalledWith(expect.objectContaining({
        scheduledDate: new Date('2026-10-02'),
        branchState: 'KL',
        excludeAssignmentId: 'asn-1',
      }));
      expect(mockUnitOfWork.run).not.toHaveBeenCalled();
    });

    it('E9: create refuses to move a live PENDING offer — BRANCH_HAS_LIVE_OFFER, pointing at Reassign', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', projectId: 'p-1', status: ProjectBranchStatus.PLANNING, branch: { name: 'Kochi', state: 'KL' }, project: {} });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-new', status: AssayerStatus.ACTIVE, isActive: true, skills: [], certifications: [] });
      mockAssignmentRepo.findOne.mockResolvedValue({ id: 'asn-live', assignmentNumber: 'ASN-9', status: AssignmentStatus.PENDING, assayerId: 'as-old' });

      let thrown: any;
      try { await service.create({ projectBranchId: 'pb-1', assayerId: 'as-new', scheduledDate: '2026-10-01' } as any, 'ops-1'); } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect(codeOf(thrown)).toBe('BRANCH_HAS_LIVE_OFFER');
      expect(thrown.message).toMatch(/Reassign/);
      expect(mockUnitOfWork.run).not.toHaveBeenCalled();
      expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalled();
    });

    it('E9: a DECLINED row is still re-offered through create', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', projectId: 'p-1', status: ProjectBranchStatus.CANDIDATE_SEARCH, branch: { name: 'Kochi', state: 'KL' }, project: {} });
      mockAssayerRepo.findOne.mockResolvedValue({ id: 'as-new', status: AssayerStatus.ACTIVE, isActive: true, skills: [], certifications: [] });
      // The same assayer, offered again after declining — a declined row nobody holds is reused.
      mockAssignmentRepo.findOne.mockResolvedValue({ id: 'asn-old', assignmentNumber: 'ASN-9', status: AssignmentStatus.REJECTED, assayerId: 'as-new', entityVersion: 3 });

      const result = await service.create({ projectBranchId: 'pb-1', assayerId: 'as-new', scheduledDate: '2026-10-01' } as any, 'ops-1');
      expect(result.status).toBe(AssignmentStatus.PENDING);
    });

    describe('completion notices', () => {
      const onSite = (over: any = {}) => ({
        id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.CHECKED_IN, assayerId: 'assayer-1', createdBy: 'ops-creator',
        checkedInAt: new Date('2026-08-20T04:00:00Z'), checkedOutAt: new Date('2026-08-20T07:00:00Z'), entityVersion: 1,
        assayer: { displayName: 'Anu Joseph' },
        projectBranch: { id: 'pb-1', isActive: true, status: ProjectBranchStatus.SCHEDULED, branch: { name: 'Thrissur Main' } },
        ...over,
      });

      it('tells the assayer and the job\'s creator, per occurrence, after the commit', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(onSite());
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

        await service.completeAssignment('asn-1', 'ops-1');

        const calls = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0]);
        const toAssayer = calls.find((c) => c.type === 'ASSIGNMENT_COMPLETED');
        const toDesk = calls.find((c) => c.type === 'ASSIGNMENT_COMPLETED_DESK');
        expect(toAssayer).toMatchObject({ assayerId: 'assayer-1', payload: expect.objectContaining({ branchName: 'Thrissur Main' }) });
        expect(toDesk).toMatchObject({ ownerUserId: 'ops-creator', payload: expect.objectContaining({ branchName: 'Thrissur Main', assayerName: 'Anu Joseph' }) });
        // The committed version is the occurrence: a reopened job completed again is news again.
        expect(toAssayer.dedupeKey).toMatch(/^ASSIGNMENT_COMPLETED:asn-1:\d+$/);
        expect(toDesk.dedupeKey).toMatch(/^ASSIGNMENT_COMPLETED_DESK:asn-1:\d+$/);
        // The version the completion committed (the harness locks the row at version 1).
        expect(toAssayer.dedupeKey).toBe('ASSIGNMENT_COMPLETED:asn-1:2');
      });

      it('tells the assayer even when they are the one whose upload closed the job', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(onSite());
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

        await service.completeAssignment('asn-1', 'assayer-1');

        const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
        expect(types).toContain('ASSIGNMENT_COMPLETED');
      });

      it('sends nothing when the completion does not commit', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(onSite());
        mockUnitOfWork.run.mockImplementationOnce(async () => { throw new Error('serialization failure'); });

        await expect(service.completeAssignment('asn-1', 'ops-1')).rejects.toThrow();

        const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
        expect(types).not.toContain('ASSIGNMENT_COMPLETED');
        expect(types).not.toContain('ASSIGNMENT_COMPLETED_DESK');
      });
    });

    it('E11: a date change is keyed per occurrence, so A → B → A → B reaches the assayer every time', async () => {
      const row: any = pendingOn('2026-10-01', { entityVersion: 4, projectBranch: { projectId: null, branch: { name: 'Kochi', state: 'KL' } } });
      mockAssignmentRepo.findOne.mockResolvedValue(row);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await service.update('asn-1', { scheduledDate: '2026-10-02' } as any, 'ops-1');
      await service.update('asn-1', { scheduledDate: '2026-10-01' } as any, 'ops-1');
      await service.update('asn-1', { scheduledDate: '2026-10-02' } as any, 'ops-1');

      const keys = mockNotificationDispatch.emitSafe.mock.calls
        .map((c: any[]) => c[0])
        .filter((c) => c.type === 'ASSIGNMENT_DATE_CHANGED')
        .map((c) => c.dedupeKey);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3);
      expect(keys[0]).toMatch(/^ASSIGNMENT_DATE_CHANGED:asn-1:2026-10-02:\d+$/);
    });

    it('B14: a job dated for the first time re-decides the day it lands on', async () => {
      const row: any = pendingOn('2026-10-01', { entityVersion: 4, projectBranch: { projectId: null, branch: { name: 'Kochi', state: 'KL' } } });
      row.scheduledDate = null;
      mockAssignmentRepo.findOne.mockResolvedValue(row);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      const rebalanceMany = jest.fn(async () => undefined);
      (service as any).dayTravel = { rebalanceMany };

      await service.update('asn-1', { scheduledDate: '2026-10-02' } as any, 'ops-1');

      expect(rebalanceMany).toHaveBeenCalledWith(
        [expect.objectContaining({ day: '2026-10-02', arrivingAssignmentId: 'asn-1' })],
        'ops-1',
        expect.stringContaining('moved'),
      );
    });
  });

  describe('rejectOffer', () => {
    it('should reject and mark branch as CANDIDATE_SEARCH', async () => {
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.PENDING,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const result = await service.rejectOffer('asn-1', 'user-1', 'Too far');
      expect(result.status).toBe(AssignmentStatus.REJECTED);
      expect(result.rejectReason).toBe('Too far');
    });
  });

  /**
   * A cancelled or rejected job must leave the calendar with it.
   *
   * Only completion used to touch the schedule row, so a cancelled visit stayed CONFIRMED on
   * the calendar — and because "not yet scheduled" is `NOT EXISTS (… is_active = true)`, the
   * branch also vanished from the list someone would use to re-book it.
   */
  describe('the calendar entry follows the assignment', () => {
    const withSchedule = (status: AssignmentStatus, branchStatus: ProjectBranchStatus) => {
      const assignment = { id: 'asn-1', status, projectBranch: { id: 'pb-1', status: branchStatus } };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockScheduleRepoInTx.findOne.mockResolvedValue({
        id: 'sched-1', assignmentId: 'asn-1', status: 'CONFIRMED', isActive: true,
      });
    };

    it('retires the calendar entry when the job is cancelled', async () => {
      withSchedule(AssignmentStatus.ACCEPTED, ProjectBranchStatus.ASSIGNMENT_CONFIRMED);

      await service.cancelAssignment('asn-1', 'user-1', 'Client postponed');

      expect(mockScheduleRepoInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sched-1', isActive: false }),
      );
    });

    it('retires it when the offer is rejected', async () => {
      withSchedule(AssignmentStatus.PENDING, ProjectBranchStatus.NEGOTIATION);

      await service.rejectOffer('asn-1', 'user-1', 'Too far');

      expect(mockScheduleRepoInTx.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sched-1', isActive: false }),
      );
    });

    it('leaves the calendar alone when there is no entry to retire', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', status: AssignmentStatus.ACCEPTED,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.ASSIGNMENT_CONFIRMED },
      });
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockScheduleRepoInTx.findOne.mockResolvedValue(null);

      await service.cancelAssignment('asn-1', 'user-1', 'Admin override');

      expect(mockScheduleRepoInTx.save).not.toHaveBeenCalled();
    });
  });

  describe('cancelAssignment', () => {
    it('should cancel assignment', async () => {
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.ACCEPTED,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.ASSIGNMENT_CONFIRMED },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const result = await service.cancelAssignment('asn-1', 'user-1', 'Admin override');
      expect(result.status).toBe(AssignmentStatus.CANCELLED);
    });
  });

  /**
   * minDistanceKm is a conflict-of-interest floor: an assayer must be far ENOUGH from the
   * branch they audit. The day planner always excluded on it, but the single-branch path only
   * subtracted 40 points from the score and this write path did not check at all, so the
   * control could be bypassed simply by using the per-branch flow.
   */
  /**
   * The day planner charges a shared route once and says so; assignment creation charged full
   * travel per branch, so a two-branch day billed the same journey twice and the plan's
   * estimate never matched the assignments it produced.
   */
  /**
   * The day planner charges a shared route once and says so; assignment creation charged full
   * travel per branch, so a two-branch day billed the same journey twice and the plan's
   * estimate never matched the assignments it produced.
   */
  describe('travel is charged once per assayer-day', () => {
    const setup = () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', projectId: 'p-1',
        branch: { name: 'Test', state: 'MH', latitude: 18.5, longitude: 73.8 },
        project: {},
      });
      mockAssayerRepo.findOne.mockResolvedValue({
        // homeLatitude/homeLongitude are getters on AssayerEntity; a plain fixture object does
        // not inherit them, so they must be set explicitly or the distance reads as absent.
        id: 'as-1', skills: [], certifications: [],
        latitude: 19.0, longitude: 72.0, homeLatitude: 19.0, homeLongitude: 72.0,
      });
      mockAssignmentRepo.create.mockReturnValue({ id: 'asn-1', status: AssignmentStatus.PENDING });
      mockAssignmentRepo.save.mockResolvedValue({ id: 'asn-1', status: AssignmentStatus.PENDING });
      mockFeePolicyService.quote.mockClear();
    };

    it('quotes travel on the first assignment of a day', async () => {
      setup();
      // No existing assignment for this assayer on this date — the journey is not yet paid for.
      mockAssignmentRepo.findOne.mockResolvedValue(null);

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', proposedFee: 500, scheduledDate: '2026-08-20' } as any, 'user-1');

      const quoteArgs = mockFeePolicyService.quote.mock.calls.at(-1)?.[0];
      expect(quoteArgs.distanceKm).toBeGreaterThan(0);
    });

    /**
     * Owner decision 2026-09-24 (E2): the decision is taken INSIDE the transaction, under the
     * assayer lock — `dayTravelAlreadyCharged` asks whether another of their jobs that day already
     * carries travel. Both quotes are taken beforehand (the calculator may call out to a router).
     */
    it('quotes base fee only for a second branch on the same day', async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      // Base-only first, full second — the order create() asks in.
      mockFeePolicyService.quote
        .mockResolvedValueOnce({ baseFee: 1200, baseComponent: 1200, travelFee: 0, total: 1200 })
        .mockResolvedValueOnce({ baseFee: 1200, baseComponent: 1200, travelFee: 300, total: 1500, transport: { recommended: { mode: 'BUS' } } });
      mockUnitOfWork.run.mockImplementationOnce(async (work: any) => {
        const real = mockUnitOfWork.run.getMockImplementation()!;
        return real(async (manager: any, emit: any) => {
          const q = manager.query;
          manager.query = jest.fn(async (sql: string, params?: any[]) =>
            (String(sql).includes(DAY_TRAVEL_QUERY_MARKER) ? [{ id: 'asn-morning' }] : q(sql, params)));
          return work(manager, emit);
        });
      });

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', scheduledDate: '2026-08-20' } as any, 'user-1');

      const created = mockAssignmentRepo.create.mock.calls.at(-1)?.[0];
      const saved = lastSavedInTx;
      // Priced base-only: no travel, no transport mode, and the fee is the base.
      expect(saved.quotedTravelFee).toBe(0);
      expect(saved.quotedTransportMode).toBeNull();
      expect(saved.proposedFee).toBe(1200);
      expect(saved.agreedFee).toBe(1200);
      // The distance is a measurement and stays.
      expect(created.quotedDistanceKm).toBeGreaterThan(0);
    });

    it('keeps a fee the desk typed on a second branch, and still records no travel quote', async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      mockFeePolicyService.quote
        .mockResolvedValueOnce({ baseFee: 1200, baseComponent: 1200, travelFee: 0, total: 1200 })
        .mockResolvedValueOnce({ baseFee: 1200, baseComponent: 1200, travelFee: 300, total: 1500 });
      mockUnitOfWork.run.mockImplementationOnce(async (work: any) => {
        const real = mockUnitOfWork.run.getMockImplementation()!;
        return real(async (manager: any, emit: any) => {
          const q = manager.query;
          manager.query = jest.fn(async (sql: string, params?: any[]) =>
            (String(sql).includes(DAY_TRAVEL_QUERY_MARKER) ? [{ id: 'asn-morning' }] : q(sql, params)));
          return work(manager, emit);
        });
      });

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', proposedFee: 1400, scheduledDate: '2026-08-20' } as any, 'user-1');

      // The desk's number went in at create and was not overwritten under the lock…
      expect(mockAssignmentRepo.create.mock.calls.at(-1)?.[0].proposedFee).toBe(1400);
      expect(lastSavedInTx.proposedFee).toBeUndefined();
      // …while the travel quote on the record is the base-only one.
      expect(lastSavedInTx.quotedTravelFee).toBe(0);
    });

    it('charges travel on the first job of the day, asking under the transaction for the same assayer and date', async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      mockFeePolicyService.quote
        .mockResolvedValueOnce({ baseFee: 1200, baseComponent: 1200, travelFee: 0, total: 1200 })
        .mockResolvedValueOnce({ baseFee: 1200, baseComponent: 1200, travelFee: 300, total: 1500 });
      let asked: any[] | undefined;
      mockUnitOfWork.run.mockImplementationOnce(async (work: any) => {
        const real = mockUnitOfWork.run.getMockImplementation()!;
        return real(async (manager: any, emit: any) => {
          const q = manager.query;
          manager.query = jest.fn(async (sql: string, params?: any[]) => {
            if (String(sql).includes(DAY_TRAVEL_QUERY_MARKER)) { asked = params; return []; }
            return q(sql, params);
          });
          return work(manager, emit);
        });
      });

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', scheduledDate: '2026-08-20' } as any, 'user-1');

      expect(asked).toEqual(['as-1', '2026-08-20', null]);
      const created = mockAssignmentRepo.create.mock.calls.at(-1)?.[0];
      expect(created.quotedTravelFee).toBe(300);
      expect(created.proposedFee).toBe(1500);
      // Nothing re-priced it under the lock.
      expect(lastSavedInTx.quotedTravelFee).toBeUndefined();
    });

    it("hands the branch's place to the quote so transport rates can price the journey", async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue(null);

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', scheduledDate: '2026-08-20' } as any, 'user-1');

      const quoteArgs = mockFeePolicyService.quote.mock.calls.at(-1)?.[0];
      expect(quoteArgs.place).toBeDefined();
      // The fixture branch carries whatever state/region the setup gave it; what matters is
      // the shape reached the calculator rather than being dropped on the way.
      expect(quoteArgs.place).toHaveProperty('state');
      expect(quoteArgs.place).toHaveProperty('region');
    });

    it('freezes the quoted breakdown on the offer — recommendation stays distinguishable from agreement', async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      // The base-only quote is taken first, the full one second — see create().
      mockFeePolicyService.quote.mockResolvedValueOnce({
        baseFee: 1200, branchCount: 1, baseComponent: 1200,
        distanceKm: 0, chargeableKm: 0, travelFee: 0, total: 1200,
        usedFallbackBaseFee: false,
        rates: { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true },
      }).mockResolvedValueOnce({
        baseFee: 1200, branchCount: 1, baseComponent: 1200,
        distanceKm: 40, chargeableKm: 40, travelFee: 130, total: 1330,
        usedFallbackBaseFee: false,
        rates: { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true },
        travelSource: 'TRANSPORT_RATE_CARD',
        transport: { distanceKm: 40, options: [], recommended: { mode: 'BUS' } },
      });

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', scheduledDate: '2026-08-20' } as any, 'user-1');

      const created = mockAssignmentRepo.create.mock.calls.at(-1)?.[0];
      expect(created.quotedBaseFee).toBe(1200);
      expect(created.quotedTravelFee).toBe(130);
      expect(created.quotedTransportMode).toBe('BUS');
      expect(created.quotedDistanceKm).toBeGreaterThan(0);
      // The default routing double returns no `source` — a route from something older than the
      // labelled provider — and the only honest label for that is an estimate.
      expect(created.quotedDistanceSource).toBe('ESTIMATE');
    });

    /**
     * How the kilometres were measured is frozen beside them. A travel allowance quoted from a
     * straight line while the router was down and one quoted by road differ by 11–56 % on real
     * pairs; audit and travel verification must be able to tell which this offer was.
     */
    it('records whether the quoted distance was measured by road or estimated, and hands the road leg to the quote', async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue(null);
      mockRoutingService.calculateRoute.mockResolvedValueOnce({ distanceKm: 84.6, durationMinutes: 70, source: 'OSRM' });

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', scheduledDate: '2026-08-20' } as any, 'user-1');

      const created = mockAssignmentRepo.create.mock.calls.at(-1)?.[0];
      expect(created.quotedDistanceKm).toBe(84.6);
      expect(created.quotedDistanceSource).toBe('OSRM');

      // The same routed leg reaches the calculator, so the transport rate card times road
      // modes by the real drive — the input the planning screen's quote also receives.
      const quoteArgs = mockFeePolicyService.quote.mock.calls.at(-1)?.[0];
      expect(quoteArgs.road).toEqual({ distanceKm: 84.6, durationMinutes: 70, source: 'OSRM' });
    });

    it('records no distance source when no distance was quoted', async () => {
      setup();
      // No branch coordinates: nothing to route, nothing to label.
      mockProjectBranchRepo.findOne.mockResolvedValue({
        id: 'pb-1', projectId: 'p-1', branch: { name: 'Test', state: 'MH' }, project: {},
      });
      mockAssignmentRepo.findOne.mockResolvedValue(null);

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', scheduledDate: '2026-08-20' } as any, 'user-1');

      const created = mockAssignmentRepo.create.mock.calls.at(-1)?.[0];
      expect(created.quotedDistanceKm).toBeNull();
      expect(created.quotedDistanceSource).toBeNull();
      const quoteArgs = mockFeePolicyService.quote.mock.calls.at(-1)?.[0];
      expect(quoteArgs.road).toBeNull();
    });
  });

  describe('client distance policy', () => {
    it('refuses an assayer too close to the branch they would audit', async () => {
      mockConstraintEvaluator.checkDistancePolicy.mockReturnValueOnce({
        passed: false,
        reason: "Conflict of interest: 2.0km is within the client's 5km minimum-distance rule.",
      });

      await expect(
        service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', proposedFee: 1500, scheduledDate: '2026-08-20' }, 'user-1'),
      ).rejects.toThrow(/Conflict of interest/);

      expect(mockAssignmentRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('scheduleAudit', () => {
    it('should update project branch status to SCHEDULED', async () => {
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.ACCEPTED, scheduledDate: null,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.ASSIGNMENT_CONFIRMED },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const result = await service.scheduleAudit('asn-1', 'user-1', '2026-08-15');
      expect(result.scheduledDate).toEqual(new Date('2026-08-15'));
    });

    /**
     * scheduleAudit is the funnel every scheduled-date write passes through — assignment
     * creation, SchedulingService.create, and the Reschedule button, which previously reached
     * it with no date validation at all. Guarding here closes all of them, so this test is
     * what stops a reschedule onto a holiday or onto an assayer's leave.
     */
    it('refuses a date the assayer cannot work, whichever path asked', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', status: AssignmentStatus.ACCEPTED, assayerId: 'as-1',
        projectBranch: { id: 'pb-1', branch: { state: 'Maharashtra' } },
      });
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValueOnce({
        passed: false,
        reason: 'Holiday Conflict: 2026-08-15 is a national/bank holiday in Maharashtra.',
      });

      await expect(
        service.scheduleAudit('asn-1', 'user-1', '2026-08-15'),
      ).rejects.toThrow(/Holiday Conflict/);

      // Nothing may be written when the date is rejected.
      expect(mockAssignmentRepo.save).not.toHaveBeenCalled();
    });

    /**
     * `slaDueDate` measures "attend by the scheduled day". Moving the date without re-arming it
     * left the old deadline standing: a reschedule pushed a week out still read BREACHED against
     * a day that no longer applied, and a pull-in got a deadline later than the actual visit —
     * the SLA scanner and the falling-behind board would both be judging the wrong date.
     */
    it('re-arms slaDueDate to the new scheduled day, the same rule acceptance uses', async () => {
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.ACCEPTED,
        scheduledDate: new Date('2026-08-01'),
        // Stale: set for the OLD date, and already breached under it.
        slaDueDate: new Date('2026-08-01T23:59:59+05:30'),
        slaStatus: 'BREACHED',
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.SCHEDULED },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const result = await service.scheduleAudit('asn-1', 'user-1', '2026-08-20');

      expect(result.slaDueDate).toEqual(new Date('2026-08-20T23:59:59+05:30'));
      // The mutation this proves: deleting the two `slaDueDate`/`slaStatus` re-arm lines in
      // scheduleAudit leaves this assertion comparing against the stale 2026-08-01 deadline.
      expect(result.slaDueDate).not.toEqual(new Date('2026-08-01T23:59:59+05:30'));
      expect(result.slaStatus).toBe('COMPLIANT');
    });
  });

  /**
   * In-app fee negotiation is REMOVED (2026-09). The `proposeCounterFee` service method and the
   * controller's counter branch are deleted; what remains to hold still is the REFUSAL. Old
   * sideloaded APKs keep POSTing counters, and they must get the deliberate 400 that explains
   * the policy — not a generic message, and never a code path that quietly re-opens pricing.
   * These pin the controller gate the way `fee-self-dealing.spec.ts` pins its neighbour.
   */
  describe('transition — the negotiation refusal', () => {
    const REFUSAL =
      'Fee negotiation has been removed from the app. Please accept or decline the offer; '
      + 'fee questions are settled with the operations desk by phone. Update your app to the latest version.';

    function makeController() {
      const assignmentService = {
        acceptOffer: jest.fn().mockResolvedValue({ id: 'asn-1', status: 'ACCEPTED' }),
        // Ownership check support: the assignment belongs to the caller.
        findOne: jest.fn().mockResolvedValue({ assayerId: 'user-1' }),
      };
      const controller = new AssignmentController(
        assignmentService as any,
        {} as any,
        { assertAssignmentInScope: jest.fn(), assertBranchInScope: jest.fn() } as any,
      );
      return { controller, assignmentService };
    }

    const reqAs = (roles: string[], id = 'user-1') => ({ user: { id, roles } });

    /** Awaits the call and asserts the EXACT refusal — the class and the whole message, not a
     *  substring, because the message IS the product here: it is all an old build can show. */
    const expectRefusal = async (call: Promise<unknown>) => {
      const caught: any = await call.then(
        () => { throw new Error('expected the transition to be refused'); },
        (e) => e,
      );
      expect(caught).toBeInstanceOf(BadRequestException);
      expect(caught.message).toBe(REFUSAL);
    };

    it.each(['COUNTER_OFFER', 'NEGOTIATION'])(
      'refuses an assayer POSTing %s with the exact update-your-app message',
      async (targetStatus) => {
        const { controller, assignmentService } = makeController();
        await expectRefusal(
          controller.transition('asn-1', { targetStatus, counterTravelFee: 500 }, reqAs(['ASSAYER'])),
        );
        // The refusal is a wall, not a detour: nothing may reach the service.
        expect(assignmentService.findOne).not.toHaveBeenCalled();
        expect(assignmentService.acceptOffer).not.toHaveBeenCalled();
      },
    );

    it('refuses a fee-carrying PENDING — how the oldest builds phrased a counter', async () => {
      const { controller } = makeController();
      await expectRefusal(
        controller.transition('asn-1', { targetStatus: 'PENDING', counterTravelFee: 650 }, reqAs(['ASSAYER'])),
      );
      // Every legacy alias for the figure is the same refusal.
      for (const key of ['counterFee', 'fee', 'proposedFee']) {
        await expectRefusal(
          controller.transition('asn-1', { targetStatus: 'PENDING', [key]: 1900 }, reqAs(['ASSAYER'])),
        );
      }
    });

    /**
     * A BARE `PENDING` (no fee keys) is not a counter-offer, so it must not get the negotiation
     * message. It now falls through to the trimmed allow-list — `PENDING` left
     * `ASSAYER_TRANSITIONS` with the counter machinery — whose 403 explains that lifecycle
     * moves belong to the desk.
     */
    it('does not give the negotiation refusal to a bare PENDING', async () => {
      const { controller } = makeController();
      const caught: any = await controller
        .transition('asn-1', { targetStatus: 'PENDING' }, reqAs(['ASSAYER']))
        .then(
          () => { throw new Error('expected the transition to be refused'); },
          (e) => e,
        );
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect(caught.message).not.toBe(REFUSAL);
    });

    it('still lets the assayer accept — the fee-less accept/decline survives the removal', async () => {
      const { controller, assignmentService } = makeController();
      await controller.transition('asn-1', { targetStatus: 'ACCEPTED' }, reqAs(['ASSAYER']));
      expect(assignmentService.acceptOffer).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The machine half of the kill-switch. Shipped mobile builds gate their own counter-offer
   * button on this number, so `maxNegotiationRounds: 0` makes a pre-removal APK show
   * "Negotiation closed" by itself — no forced update. The KEY must stay while those builds are
   * in the field; the VALUE must be the literal 0, not a setting an administrator could raise.
   */
  describe('platform limits — the negotiation kill-switch', () => {
    it('serves maxNegotiationRounds: 0, whatever the settings store holds', async () => {
      const settings = {
        // Even a store that still carries the deleted field.maxNegotiationRounds row (it was
        // registry-managed; the registry entry is gone) must not resurrect the feature.
        getNumber: jest.fn().mockImplementation((_key: string, fallback: number) => Promise.resolve(fallback)),
      };
      const controller = new PlatformSettingsController(settings as any, {} as any);

      const res = await controller.limits();

      expect(res.maxNegotiationRounds).toBe(0);
      // The neighbours still resolve from settings — only the negotiation cap is nailed down.
      expect(res.checkInGeofenceMeters).toBe(2000);
      expect(res.maxSingleExpenseClaim).toBe(50_000);
      expect(settings.getNumber).not.toHaveBeenCalledWith('field.maxNegotiationRounds', expect.anything());
    });
  });

  describe('update', () => {
    it('should throw BadRequestException if assignment is not PENDING', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', status: AssignmentStatus.ACCEPTED,
        projectBranch: { id: 'pb-1' },
      });
      await expect(
        service.update('asn-1', { proposedFee: 600 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  /**
   * The list pages on ids and then hydrates. These guard the invariant that broke when it shipped.
   *
   * Dropping `relations` does not remove TypeORM's `SELECT DISTINCT … "distinctAlias"` wrapper —
   * joins do, and every filter that reaches through `projectBranch` still joins. The wrapper
   * projects exactly what `select` lists and then orders the outer query by the sort columns, so
   * a sort column missing from `select` is a 500 from the database, not a type error.
   *
   * The first version selected `id` alone. It was measured on the unfiltered list, which has no
   * joins and therefore no wrapper, so it looked fine; every filtered view returned
   * `column distinctAlias.AssignmentEntity_created_at does not exist`. A mocked repository cannot
   * reproduce the SQL, so the assertion here is on the shape that has to hold for the SQL to be
   * legal: **everything ordered by is selected**.
   */
  describe('list pagination', () => {
    const pageOptions = () => mockAssignmentRepo.find.mock.calls[0][0];

    beforeEach(() => {
      mockAssignmentRepo.find.mockResolvedValue([]);
      mockAssignmentRepo.count.mockResolvedValue(0);
    });

    it('selects every column it orders by, or the distinct wrapper cannot resolve them', async () => {
      await service.findAll(1, 25);
      const { select, order } = pageOptions();

      for (const column of Object.keys(order)) {
        expect(select).toHaveProperty(column);
      }
    });

    it('orders by a total order, so a page boundary cannot fall inside a tie', async () => {
      await service.findAll(1, 25);
      expect(pageOptions().order).toEqual({ createdAt: 'DESC', id: 'ASC' });
    });

    it('holds when the filters join through projectBranch — the shape that actually broke', async () => {
      // unscheduledOnly + projectBranchStatus is the combination the planning screen sends, and
      // the one that 500'd: both reach through the relation, so both produce the join.
      await service.findAll(1, 100, undefined, 'ASSIGNMENT_CONFIRMED', true);
      const { select, order } = pageOptions();

      for (const column of Object.keys(order)) {
        expect(select).toHaveProperty(column);
      }
    });

    it('does not ask for the six relations while paginating — that was the 28kb query', async () => {
      await service.findAll(1, 25);
      expect(pageOptions().relations).toBeUndefined();
    });
  });

  describe('autoDeclineExpiredOffers', () => {
    it('auto-declines a PENDING assignment past its slaDueDate', async () => {
      const pastDue = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.PENDING, slaDueDate: pastDue,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION },
      };
      mockAssignmentRepo.find.mockResolvedValue([assignment]);
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const declinedCount = await service.autoDeclineExpiredOffers();

      expect(declinedCount).toBe(1);
      expect(assignment.status).toBe(AssignmentStatus.REJECTED);
      expect((assignment as any).rejectReason).toBe('AUTO_DECLINED_SLA_EXPIRED');
      expect(assignment.projectBranch.status).toBe(ProjectBranchStatus.CANDIDATE_SEARCH);
    });

    it('leaves a PENDING assignment untouched if its slaDueDate has not passed yet', async () => {
      const notYetDue = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
      const assignment = {
        id: 'asn-1', status: AssignmentStatus.PENDING, slaDueDate: notYetDue,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION },
      };
      mockAssignmentRepo.find.mockResolvedValue([assignment]);

      const declinedCount = await service.autoDeclineExpiredOffers();

      expect(declinedCount).toBe(0);
      expect(assignment.status).toBe(AssignmentStatus.PENDING);
      expect(mockAssignmentRepo.save).not.toHaveBeenCalled();
    });

    it('queries only active PENDING assignments, so non-PENDING assignments are never considered', async () => {
      mockAssignmentRepo.find.mockResolvedValue([]);

      const declinedCount = await service.autoDeclineExpiredOffers();

      expect(declinedCount).toBe(0);
      expect(mockAssignmentRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: AssignmentStatus.PENDING, isActive: true }),
        }),
      );
    });

    /**
     * The scale fix: the overdue filter lives in SQL, so the scan loads only the offers actually
     * past their deadline — not the whole active-pending pool tested row-by-row in JS (28,571
     * rows loaded to act on 555 on the 200k-assignment scale DB).
     */
    it('pushes the past-due filter into the query and loads the branch relation with it', async () => {
      mockAssignmentRepo.find.mockResolvedValue([]);

      await service.autoDeclineExpiredOffers();

      const arg = mockAssignmentRepo.find.mock.calls.at(-1)![0] as any;
      // A LessThan(now) FindOperator, i.e. the date is filtered in Postgres, not in the loop.
      expect(arg.where.slaDueDate?.type).toBe('lessThan');
      // Branch joined in the same query, replacing the per-row findOne the notification used to do.
      expect(arg.relations).toEqual(expect.arrayContaining(['projectBranch', 'projectBranch.branch']));
    });
  });

  describe('checkSlaBreaches', () => {
    it('flags an overdue offer, records the audit event, and notifies once', async () => {
      const assignment = {
        id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: AssignmentStatus.PENDING,
        slaStatus: 'COMPLIANT', slaDueDate: new Date(Date.now() - 3600_000), assayerId: 'as-1',
        createdBy: 'user-1', projectBranch: { branch: { name: 'Thrissur Main' } },
      };
      mockAssignmentRepo.find.mockResolvedValue([assignment]);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const breached = await service.checkSlaBreaches();

      expect(breached).toBe(1);
      expect(assignment.slaStatus).toBe('BREACHED');
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ASSIGNMENT_SLA_BREACHED', entityId: 'asn-1' }),
      );
      expect(mockNotificationDispatch.emitSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ASSIGNMENT_SLA_BREACHED',
          // Read from the relation loaded by the main query — no second findOne per breach.
          payload: expect.objectContaining({ branchName: 'Thrissur Main', slaType: 'response' }),
        }),
      );
    });

    it('filters overdue in SQL and joins the branch, instead of scanning the whole open pool', async () => {
      mockAssignmentRepo.find.mockResolvedValue([]);

      await service.checkSlaBreaches();

      const arg = mockAssignmentRepo.find.mock.calls.at(-1)![0] as any;
      expect(arg.where.slaStatus).toBe('COMPLIANT');
      expect(arg.where.slaDueDate?.type).toBe('lessThan');
      expect(arg.relations).toEqual(expect.arrayContaining(['projectBranch', 'projectBranch.branch']));
      // Nothing overdue -> nothing written.
      expect(mockAssignmentRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('escalate', () => {
    it('bumps priority to CRITICAL and records an audit event', async () => {
      const assignment = {
        id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: AssignmentStatus.PENDING,
        priority: Priority.MEDIUM, createdBy: 'ops-user-1',
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const result = await service.escalate('asn-1', 'ops-user-2', 'Branch manager unresponsive');

      expect(result.priority).toBe(Priority.CRITICAL);
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ASSIGNMENT_ESCALATED', entityId: 'asn-1' }),
      );
    });

    it('escalation notifies the operations roles, not just the raiser', async () => {
      // Escalation previously notified `createdBy` alone, so an escalation
      // raised while that one person was away reached nobody. It now goes
      // through the catalog, which resolves the operations and administrator
      // roles at send time.
      const assignment = {
        id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: AssignmentStatus.PENDING,
        priority: Priority.MEDIUM, createdBy: 'ops-user-1',
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-user-1' });

      await service.escalate('asn-1', 'ops-user-2', 'Client escalated.');

      expect(mockNotificationDispatch.emitSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ASSIGNMENT_ESCALATED',
          entityId: 'asn-1',
          actorUserId: 'ops-user-2',
          ownerUserId: 'ops-user-1',
        }),
      );
    });

    it('does not re-notify an assignment that is already CRITICAL', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', assignmentNumber: 'ASN-2026-1', status: AssignmentStatus.PENDING,
        priority: Priority.CRITICAL, createdBy: 'ops-user-1',
      });
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      await service.escalate('asn-1', 'ops-user-2');

      expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalled();
    });

    it('rejects escalating an assignment that is already COMPLETED', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', status: AssignmentStatus.COMPLETED, priority: Priority.MEDIUM,
      });

      await expect(service.escalate('asn-1', 'ops-user-2')).rejects.toThrow(BadRequestException);
    });
  });

  describe('recordCheckIn — attendance evidence integrity', () => {
    // Check-in is the record asserting a field worker physically stood inside a bank branch.
    // It is evidence in a collateral audit, so each of these guards protects a real claim.

    const acceptedAssignment = (over: any = {}) => ({
      id: 'asn-1',
      assayerId: 'assayer-1',
      status: AssignmentStatus.ACCEPTED,
      syncToken: null,
      projectBranch: { branch: { latitude: '12.9716', longitude: '77.5946' } },
      assessment: null,
      ...over,
    });

    /**
     * E12 (owner decision 2026-09-24): the office may still check an assayer in, skipping the day
     * and distance rules, but only with a written reason — recorded on the job as an office
     * check-in, and told to the assayer.
     */
    describe('checked in by the office', () => {
      it('refuses an office check-in with no reason, with a stable code, and writes nothing', async () => {
        const assignment = acceptedAssignment();
        mockAssignmentRepo.findOne.mockResolvedValue(assignment);
        mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1', roles: [{ name: 'OPERATIONS' }] });

        let thrown: any;
        try {
          await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'ops-1', undefined, { officeReason: '   ' });
        } catch (e) { thrown = e; }

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect(thrown.getResponse?.()?.code ?? thrown.code).toBe('OFFICE_CHECK_IN_REASON_REQUIRED');
        expect(assignment.status).toBe(AssignmentStatus.ACCEPTED);
        expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalled();
      });

      it('records the reason as an office check-in and tells the assayer after the write', async () => {
        const assignment: any = acceptedAssignment({ assignmentNumber: 'ASN-5', projectBranch: { branch: { name: 'Kochi Main', latitude: '12.9716', longitude: '77.5946' } } });
        mockAssignmentRepo.findOne.mockResolvedValue(assignment);
        mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1', roles: [{ name: 'OPERATIONS' }] });
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

        // Far from the branch and on no particular day: the office still skips both rules.
        const res = await service.recordCheckIn('asn-1', 28.6315, 77.2167, undefined, 'ops-1', undefined, { officeReason: '  Phone died at the branch.  ' });

        expect(res.success).toBe(true);
        expect(assignment.checkInOfficeReason).toBe('Phone died at the branch.');
        expect(assignment.checkInTimeOutcome).toBe('NOT_FROM_ASSAYER');
        expect(mockNotificationDispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({
          type: 'ASSIGNMENT_CHECKED_IN_BY_OFFICE',
          assayerId: 'assayer-1',
          payload: expect.objectContaining({ branchName: 'Kochi Main', reason: 'Phone died at the branch.' }),
        }));
      });

      it('asks nothing of the assayer checking themselves in, and marks nothing as the office', async () => {
        const assignment: any = acceptedAssignment({ scheduledDate: new Date() });
        mockAssignmentRepo.findOne.mockResolvedValue(assignment);
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

        const res = await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1');

        expect(res.success).toBe(true);
        expect(assignment.checkInOfficeReason).toBeNull();
        const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
        expect(types).not.toContain('ASSIGNMENT_CHECKED_IN_BY_OFFICE');
      });
    });

    it('refuses a check-in from an assayer the assignment does not belong to', async () => {
      // Previously any authenticated assayer could check in on ANY assignment id, recording
      // attendance at a branch they were never assigned.
      mockAssignmentRepo.findOne.mockResolvedValue(acceptedAssignment());
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'assayer-2', roles: [{ name: 'ASSAYER' }] });

      const res = await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'assayer-2');

      expect(res.success).toBe(false);
      expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
    });

    it('refuses a check-in before the assignment has been accepted', async () => {
      // Checking in straight from PENDING skipped acceptance entirely.
      mockAssignmentRepo.findOne.mockResolvedValue(acceptedAssignment({ status: AssignmentStatus.PENDING }));

      const res = await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'assayer-1');

      expect(res.success).toBe(false);
      expect(res.error).toBe('INVALID_STATE_FOR_CHECK_IN');
    });

    it('lets an operations manager check in on an assayer behalf', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(acceptedAssignment());
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1', roles: [{ name: 'OPERATIONS' }] });
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const res = await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'ops-1', undefined, { officeReason: 'Phone broke on site; branch manager confirmed arrival.' });

      expect(res.success).toBe(true);
    });

    it('tells whoever created the assignment about the check-in, through the catalog rather than a hand-rolled create() call', async () => {
      const assignment = acceptedAssignment({
        createdBy: 'ops-1',
        assayer: { displayName: 'Asha Rao' },
        projectBranch: { branch: { latitude: '12.9716', longitude: '77.5946', name: 'Koramangala' } },
      });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1' });

      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1');

      expect(mockNotificationDispatch.emitSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ASSIGNMENT_CHECKED_IN',
          entityType: 'ASSIGNMENT',
          entityId: 'asn-1',
          ownerUserId: 'ops-1',
          dedupeKey: expect.stringMatching(/^ASSIGNMENT_CHECKED_IN:asn-1:/),
          payload: expect.objectContaining({
            assignmentId: 'asn-1',
            assayerName: 'Asha Rao',
            branchName: 'Koramangala',
          }),
        }),
      );
    });

    it('sends no check-in notification when the creating user no longer exists', async () => {
      const assignment = acceptedAssignment({ createdBy: 'ops-gone' });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockUserRepoViaDataSource.findOne.mockResolvedValue(null);

      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1');

      expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ASSIGNMENT_CHECKED_IN' }),
      );
    });

    it('stores position in real columns and computes distance from the branch', async () => {
      // This used to be concatenated into free-text `remarks`, making the single most
      // important fact in the audit unqueryable and unusable as evidence.
      const assignment = acceptedAssignment();
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 12);

      expect(assignment).toMatchObject({
        checkInLatitude: 12.9716,
        checkInLongitude: 77.5946,
        checkInAccuracyMeters: 12,
      });
      expect(assignment.checkedInAt).toBeInstanceOf(Date);
      // Same point as the branch => ~0 m away.
      expect(assignment.checkInDistanceMeters).toBeLessThan(5);
    });

    it('refuses an assayer check-in from far outside the branch geofence', async () => {
      // Production data held an assignment CHECKED_IN 677 km from its branch. The distance
      // was recorded but never acted on; now the check-in itself is refused, with the money
      // question ("were you there?") answered at the door instead of in a later dispute.
      const assignment = acceptedAssignment();
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // ~1,700 km away — the old New Delhi fallback would have looked exactly like this.
      const res = await service.recordCheckIn('asn-1', 28.6315, 77.2167, undefined, 'assayer-1');

      expect(res.success).toBe(false);
      expect(res.error).toBe('TOO_FAR_FROM_BRANCH');
      expect(assignment.status).toBe(AssignmentStatus.ACCEPTED); // untouched
    });

    it('still records a distant check-in when staff perform it as a correction', async () => {
      // The guard protects the assayer's own attestation; ops fixing a record is exactly the
      // case that must pass — and the anomalous distance stays on the row as evidence.
      const assignment = acceptedAssignment();
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1', roles: [{ name: 'OPERATIONS' }] });
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const res = await service.recordCheckIn('asn-1', 28.6315, 77.2167, undefined, 'ops-1', undefined, { officeReason: 'Correcting a record the phone could not send.' });

      expect(res.success).toBe(true);
      expect(assignment.checkInDistanceMeters).toBeGreaterThan(1_000_000);
    });

    it('widens the geofence by the GPS fix accuracy instead of punishing a poor rural signal', async () => {
      const assignment = acceptedAssignment();
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // ~2.7 km from the branch with a reported 1,000 m accuracy: 2000 + 1000 allowance lets
      // it through; the same point with a sharp fix would be refused.
      const res = await service.recordCheckIn('asn-1', 12.9716, 77.6194, undefined, 'assayer-1', 1000);

      expect(res.success).toBe(true);
      const sharp = acceptedAssignment();
      mockAssignmentRepo.findOne.mockResolvedValue(sharp);
      const refused = await service.recordCheckIn('asn-1', 12.9716, 77.6194, undefined, 'assayer-1', 10);
      expect(refused.success).toBe(false);
      expect(refused.error).toBe('TOO_FAR_FROM_BRANCH');
    });

    it('refuses a check-in days before the scheduled date', async () => {
      // The nine-days-early case from production: check-in is attendance evidence for a
      // specific visit, so it opens on the visit's own day. Ops reschedule first if the
      // visit has genuinely moved.
      const future = new Date();
      future.setDate(future.getDate() + 9);
      const assignment = acceptedAssignment({ scheduledDate: future.toISOString() });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);

      const res = await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1');

      expect(res.success).toBe(false);
      expect(res.error).toBe('NOT_SCHEDULED_TODAY');
      expect(res.message).toContain('scheduled for');
    });

    it('accepts a same-day check-in inside the geofence', async () => {
      const assignment = acceptedAssignment({ scheduledDate: new Date().toISOString() });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      const res = await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 15);

      expect(res.success).toBe(true);
      expect(assignment.status).toBe(AssignmentStatus.CHECKED_IN);
    });

    it('leaves distance null when the branch itself has no coordinates', async () => {
      const assignment = acceptedAssignment({ projectBranch: { branch: { latitude: null, longitude: null } } });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'assayer-1');

      expect(assignment.checkInDistanceMeters).toBeNull();
    });

    /**
     * The check-in is the anchor every travel assessment is measured backwards from — the one
     * moment the platform knows for certain where the assayer was. Without it in the trail, an
     * approach journey has no verified end point.
     */
    it('anchors the movement trail with the check-in fix', async () => {
      const assignment = acceptedAssignment({ scheduledDate: new Date().toISOString() });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 15);

      expect(mockLocationTrail.record).toHaveBeenCalledWith(
        'assayer-1',
        12.9716,
        77.5946,
        expect.objectContaining({ source: 'CHECK_IN', accuracyMeters: 15, assignmentId: 'asn-1' }),
      );
    });

    it('still checks in when the trail append fails — evidence must not block the record', async () => {
      const assignment = acceptedAssignment({ scheduledDate: new Date().toISOString() });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockLocationTrail.record.mockRejectedValueOnce(new Error('trail write failed'));

      // An assayer standing at the branch must not be refused because a supporting write failed.
      await expect(
        service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 15),
      ).resolves.toMatchObject({ success: true });
    });
  });


  describe('syncScheduleCompletion', () => {
    /**
     * The schedule row must be brought to COMPLETED through the caller's transaction manager.
     * It used to be raw SQL on the DataSource, outside the transaction that saves the
     * assignment and with failures swallowed — so a rollback left the schedule COMPLETED and
     * the assignment not, with nothing reported.
     */
    const makeManager = (existing: any) => {
      const repo = {
        findOne: jest.fn().mockResolvedValue(existing),
        save: jest.fn((arg: any) => Promise.resolve(arg)),
        create: jest.fn((arg: any) => arg),
      };
      return { manager: { getRepository: jest.fn().mockReturnValue(repo) } as any, repo };
    };

    const assignment: any = {
      id: 'asn-1', projectId: 'proj-1', assayerId: 'asr-1', scheduledDate: new Date('2026-06-01'),
    };

    it('completes the existing schedule through the transaction manager', async () => {
      const { manager, repo } = makeManager({ id: 'sch-1', status: 'CONFIRMED', completedAt: null });
      await (service as any).syncScheduleCompletion(assignment, 'user-1', manager);

      expect(manager.getRepository).toHaveBeenCalled();
      const saved = repo.save.mock.calls[0][0];
      expect(saved.status).toBe('COMPLETED');
      expect(saved.completedAt).toBeInstanceOf(Date);
      expect(saved.updatedBy).toBe('user-1');
    });

    it('preserves an existing completedAt — the first completion is the real one', async () => {
      const first = new Date('2026-05-01');
      const { manager, repo } = makeManager({ id: 'sch-1', status: 'COMPLETED', completedAt: first });
      await (service as any).syncScheduleCompletion(assignment, 'user-1', manager);
      expect(repo.save.mock.calls[0][0].completedAt).toBe(first);
    });

    it('creates a schedule when the assignment was never scheduled through the calendar', async () => {
      const { manager, repo } = makeManager(null);
      await (service as any).syncScheduleCompletion(assignment, 'user-1', manager);

      const created = repo.save.mock.calls[0][0];
      expect(created).toMatchObject({
        assignmentId: 'asn-1', projectId: 'proj-1', assayerId: 'asr-1', status: 'COMPLETED',
      });
    });

    it('propagates a failure instead of swallowing it', async () => {
      const { manager, repo } = makeManager({ id: 'sch-1', status: 'CONFIRMED', completedAt: null });
      repo.save.mockRejectedValueOnce(new Error('db down'));
      await expect((service as any).syncScheduleCompletion(assignment, 'user-1', manager)).rejects.toThrow('db down');
    });
  });

  describe('auto-scheduling on acceptance passes the same gate as the scheduling desk', () => {
    // This is the path almost every schedule actually takes — `autoSchedule` defaults to true —
    // so it is the one that has to be right, not the desk's.
    const acceptFlow = async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-1', assignmentNumber: 'ASN-2026-1', assayerId: 'assayer-1', projectId: 'proj-1',
        status: AssignmentStatus.PENDING, autoSchedule: true, scheduledDate: new Date('2026-09-01'),
        agreedFee: 500, proposedFee: 500, isActive: true,
        projectBranch: { id: 'pb-1', isActive: true, status: ProjectBranchStatus.NEGOTIATION, branch: { name: 'Thrissur Main', state: 'KL' } },
      } as any);
      return service.acceptOffer('asn-1', 'user-1');
    };

    beforeEach(() => {
      // The write moved onto the transaction's own manager (see the ordering fix in
      // executeAssignmentTransition), so it now lands on mockScheduleRepoInTx, not the
      // dataSource-keyed double.
      mockScheduleRepoInTx.save.mockClear();
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValue({ passed: true });
    });

    it('writes the calendar entry when the date is available', async () => {
      await acceptFlow().catch(() => undefined);
      expect(mockConstraintEvaluator.checkDateAvailability).toHaveBeenCalled();
      expect(mockScheduleRepoInTx.save).toHaveBeenCalled();
    });

    it('writes NO calendar entry when the date is refused', async () => {
      // Before the gate, this wrote a CONFIRMED dispatch on a day the assayer was on leave, on a
      // client holiday, or outside the project timeline — the exact conditions the check exists
      // for — and told nobody.
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValue({
        passed: false, reason: 'Assayer is on approved leave on 2026-09-01.',
      });
      await acceptFlow().catch(() => undefined);
      expect(mockScheduleRepoInTx.save).not.toHaveBeenCalled();
    });

    it('still accepts the offer when the date is refused', async () => {
      // The assayer said yes. A calendar clash is the desk's problem to place, not a reason to
      // silently un-accept a job someone has committed to.
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValue({ passed: false, reason: 'Client holiday.' });
      const result = await acceptFlow();
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
    });

    it('sets scheduledDate and auto-schedules when scheduledDate is provided in accept options', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue({
        id: 'asn-unscheduled', assignmentNumber: 'ASN-2026-99', assayerId: 'assayer-1', projectId: 'proj-1',
        status: AssignmentStatus.PENDING, autoSchedule: true, scheduledDate: null,
        agreedFee: 500, proposedFee: 500, isActive: true,
        projectBranch: { id: 'pb-1', isActive: true, status: ProjectBranchStatus.NEGOTIATION, branch: { name: 'Kochi Central', state: 'KL' } },
      } as any);

      const result = await service.acceptOffer('asn-unscheduled', 'user-1', 2500, 'Agreed on call', {
        scheduledDate: '2026-09-25',
      });

      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(mockConstraintEvaluator.checkDateAvailability).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledDate: new Date('2026-09-25') }),
      );
      expect(mockScheduleRepoInTx.save).toHaveBeenCalled();
    });

    it('survives the availability check throwing outright, without losing the acceptance', async () => {
      // A synchronous throw used to escape the promise-only handler and roll the acceptance back
      // to PENDING — the assayer's "yes" vanished because a calendar lookup failed.
      mockConstraintEvaluator.checkDateAvailability.mockImplementation(() => { throw new Error('db down'); });
      const result = await acceptFlow();
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(mockScheduleRepoInTx.save).not.toHaveBeenCalled();
    });

    /**
     * A concurrent cancel wins the compare-and-swap race that `executeAssignmentTransition` runs
     * under `SELECT ... FOR UPDATE`. Before this fix, the schedule write happened BEFORE that
     * check — so the calendar entry and the SCHEDULE_DISPATCHED notification had already gone
     * out by the time the CAS discovered the assignment had actually moved elsewhere, leaving
     * the assayer holding a dispatched, CONFIRMED schedule for a job that was never accepted.
     */
    it('writes no schedule and sends no dispatch notification when a concurrent cancel wins the CAS race', async () => {
      // Force the FOR UPDATE re-read to disagree with both prevStatus (PENDING) and
      // targetStatus (ACCEPTED) — exactly what a concurrent cancel produces.
      mockUnitOfWork.run.mockImplementationOnce(async (work: any) =>
        work(
          {
            save: jest.fn((arg: any) => Promise.resolve(arg)),
            query: jest.fn(async (sql: string) => {
              if (/FOR UPDATE/.test(sql)) return [{ status: AssignmentStatus.CANCELLED }];
              return [];
            }),
            getRepository: jest.fn(() => ({ findOne: jest.fn(), save: jest.fn(), create: jest.fn((a: any) => a) })),
          },
          jest.fn(),
        ),
      );

      await expect(acceptFlow()).rejects.toThrow(/changed while you were acting on it/);

      // The mutation this proves: if the schedule write (autoScheduleOnAcceptance) ran BEFORE
      // the FOR UPDATE compare-and-swap — as it did prior to this fix — this call would have
      // already happened by the time the CAS throws, regardless of the eventual conflict.
      expect(mockScheduleRepoInTx.save).not.toHaveBeenCalled();
      expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SCHEDULE_DISPATCHED' }),
      );
    });
  });

  /**
   * Owner decision 2026-09-24: the phone's own arrival time becomes the check-in time only when it
   * is today, recent, not in the future and corroborated by a trail fix inside the zone. Every
   * rejection falls back to the server's receive time, and both are stored either way.
   */
  describe('recordCheckIn — the phone\'s arrival time (arrivedAt)', () => {
    const BRANCH = { latitude: '12.9716', longitude: '77.5946' };
    const acceptedToday = () => ({
      id: 'asn-1',
      assayerId: 'assayer-1',
      status: AssignmentStatus.ACCEPTED,
      syncToken: null,
      scheduledDate: new Date().toISOString(),
      projectBranch: { branch: { ...BRANCH } },
      assessment: null,
    });
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const fixAt = (at: Date, over: any = {}) => ({
      latitude: 12.9717, longitude: 77.5947, accuracyMeters: 10, recordedAt: at, isMocked: false, ...over,
    });

    let assignment: any;
    beforeEach(() => {
      assignment = acceptedToday();
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
      mockLocationTrail.fixesBetween.mockReset().mockResolvedValue([]);
    });

    const expectServerTime = (outcome: string) => {
      expect(assignment.checkInTimeSource).toBe('SERVER');
      expect(assignment.checkInTimeOutcome).toBe(outcome);
      expect(assignment.checkedInAt).toEqual(assignment.checkInReceivedAt);
    };

    it('an old app sends nothing: server time, recorded as NOT_SENT, and the trail is not read', async () => {
      const res = await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1');
      expect(res.success).toBe(true);
      expectServerTime('NOT_SENT');
      expect(assignment.checkInClaimedArrivalAt).toBeNull();
      expect(mockLocationTrail.fixesBetween).not.toHaveBeenCalled();
    });

    it('accepts a recent arrival the trail corroborates, and keeps both times', async () => {
      const arrived = minutesAgo(3);
      mockLocationTrail.fixesBetween.mockResolvedValue([fixAt(minutesAgo(2))]);
      const res = await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, { arrivedAt: arrived.toISOString() });
      expect(res.success).toBe(true);
      expect(assignment.checkInTimeSource).toBe('DEVICE');
      expect(assignment.checkInTimeOutcome).toBe('ACCEPTED');
      expect(assignment.checkedInAt.getTime()).toBe(arrived.getTime());
      expect(assignment.checkInClaimedArrivalAt.getTime()).toBe(arrived.getTime());
      expect(assignment.checkInReceivedAt.getTime()).toBeGreaterThan(arrived.getTime());
      expect(mockLocationTrail.fixesBetween).toHaveBeenCalledWith('assayer-1', expect.any(Date), expect.any(Date));
    });

    it('refuses an arrival with no trail fix inside the zone near it', async () => {
      mockLocationTrail.fixesBetween.mockResolvedValue([fixAt(minutesAgo(2), { latitude: 13.5, longitude: 78.5 })]);
      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, { arrivedAt: minutesAgo(3).toISOString() });
      expectServerTime('NO_TRAIL_EVIDENCE');
      expect(assignment.checkInClaimedArrivalAt).toBeInstanceOf(Date);
    });

    it('does not count a mocked (spoofed) fix as evidence', async () => {
      mockLocationTrail.fixesBetween.mockResolvedValue([fixAt(minutesAgo(2), { isMocked: true })]);
      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, { arrivedAt: minutesAgo(3).toISOString() });
      expectServerTime('NO_TRAIL_EVIDENCE');
    });

    it('refuses an arrival older than the configured maximum (default 4 hours), without reading the trail', async () => {
      // Only valid when 5 hours ago is still the same IST day — otherwise DIFFERENT_DAY answers first.
      const claim = minutesAgo(5 * 60);
      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, { arrivedAt: claim.toISOString() });
      const sameDay = claim.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
        === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      expectServerTime(sameDay ? 'TOO_OLD' : 'DIFFERENT_DAY');
      expect(mockLocationTrail.fixesBetween).not.toHaveBeenCalled();
    });

    it('refuses an arrival on another day', async () => {
      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, {
        arrivedAt: new Date(Date.now() - 36 * 3_600_000).toISOString(),
      });
      expectServerTime('DIFFERENT_DAY');
    });

    it('refuses an arrival in the future beyond the clock skew', async () => {
      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, {
        arrivedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      expectServerTime('IN_FUTURE');
    });

    it('refuses an unreadable arrival time, and still checks in', async () => {
      const res = await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'assayer-1', 10, { arrivedAt: 'yesterday-ish' });
      expect(res.success).toBe(true);
      expectServerTime('UNREADABLE');
    });

    it('ignores an arrival time sent by staff checking in on the assayer\'s behalf', async () => {
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1', roles: [{ name: 'OPERATIONS' }] });
      mockLocationTrail.fixesBetween.mockResolvedValue([fixAt(minutesAgo(2))]);
      await service.recordCheckIn('asn-1', 12.9716, 77.5946, undefined, 'ops-1', 10, { arrivedAt: minutesAgo(3).toISOString(), officeReason: 'Phone out of battery.' });
      expectServerTime('NOT_FROM_ASSAYER');
    });

    it('still asks the geofence of the fix sent with the request, whatever the claimed arrival', async () => {
      mockLocationTrail.fixesBetween.mockResolvedValue([fixAt(minutesAgo(2))]);
      const res = await service.recordCheckIn('asn-1', 28.6315, 77.2167, undefined, 'assayer-1', 10, { arrivedAt: minutesAgo(3).toISOString() });
      expect(res.success).toBe(false);
      expect(res.error).toBe('TOO_FAR_FROM_BRANCH');
    });
  });

  /**
   * Owner decision 2026-09-24: job changes the assayer used to hear nothing about now reach them —
   * visibly for what they can see, and silently (a refresh push) for every change.
   */
  describe('job changes reach the assayer', () => {
    const offer = (over: any = {}) => ({
      id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.PENDING, assayerId: 'assayer-1',
      scheduledDate: new Date('2026-09-25T00:00:00+05:30'), remarks: 'Bring the seal.',
      projectBranch: { branch: { name: 'Thrissur Main' } }, entityVersion: 3, ...over,
    });
    const emitted = (type: string) => mockNotificationDispatch.emitSafe.mock.calls
      .map((c: any[]) => c[0]).filter((e: any) => e.type === type);
    beforeEach(() => {
      mockRefreshPush.assignmentChanged.mockClear();
      mockNotificationDispatch.emitSafe.mockClear();
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
    });

    it('a date change on the edit route tells the assayer the new day, and refreshes the phone', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(offer());
      await service.update('asn-1', { scheduledDate: '2026-09-28' }, 'ops-1');
      const [e] = emitted('ASSIGNMENT_DATE_CHANGED');
      expect(e).toMatchObject({ assayerId: 'assayer-1', payload: { branchName: 'Thrissur Main', newDate: 'Monday, 28 September', alsoNote: '' } });
      expect(emitted('ASSIGNMENT_NOTE_CHANGED')).toHaveLength(0);
      expect(mockRefreshPush.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
    });

    it('a note-only change sends the note notice', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(offer());
      await service.update('asn-1', { remarks: 'Branch opens at 10.' }, 'ops-1');
      expect(emitted('ASSIGNMENT_NOTE_CHANGED')).toHaveLength(1);
      expect(emitted('ASSIGNMENT_DATE_CHANGED')).toHaveLength(0);
    });

    it('an edit that changes nothing the assayer sees (fee only, same date, same note) sends nothing visible — only the refresh', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(offer());
      await service.update('asn-1', { proposedFee: 900, scheduledDate: '2026-09-25', remarks: ' Bring the seal. ' }, 'ops-1');
      expect(emitted('ASSIGNMENT_DATE_CHANGED')).toHaveLength(0);
      expect(emitted('ASSIGNMENT_NOTE_CHANGED')).toHaveLength(0);
      expect(mockRefreshPush.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
    });

    it('escalation tells the assayer holding live work — without the desk\'s reason', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(offer({ status: AssignmentStatus.ACCEPTED, priority: Priority.MEDIUM }));
      await service.escalate('asn-1', 'ops-1', 'Assayer keeps missing calls');
      const [e] = emitted('ASSIGNMENT_MARKED_URGENT');
      expect(e).toMatchObject({ assayerId: 'assayer-1', payload: { branchName: 'Thrissur Main' } });
      expect(JSON.stringify(e.payload)).not.toContain('missing calls');
      expect(mockRefreshPush.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
    });

    it('escalating a cancelled job is refused, and tells nobody', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(offer({ status: AssignmentStatus.CANCELLED, priority: Priority.MEDIUM }));
      const err: any = await service.escalate('asn-1', 'ops-1', 'x').catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: 'ASSIGNMENT_CLOSED' });
      expect(emitted('ASSIGNMENT_MARKED_URGENT')).toHaveLength(0);
      expect(emitted('ASSIGNMENT_ESCALATED')).toHaveLength(0);
    });

    it('a desk transition refreshes the assayer\'s phone; the assayer\'s own does not', async () => {
      // No entity version: the harness's locked re-read serves this same in-memory object.
      mockAssignmentRepo.findOne.mockResolvedValue(offer({ entityVersion: undefined }));
      await service.rejectOffer('asn-1', 'ops-1', 'Covered by another assayer');
      expect(mockRefreshPush.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
      mockRefreshPush.assignmentChanged.mockClear();
      mockAssignmentRepo.findOne.mockResolvedValue(offer({ entityVersion: undefined }));
      await service.rejectOffer('asn-1', 'assayer-1', 'Too far');
      expect(mockRefreshPush.assignmentChanged).not.toHaveBeenCalled();
    });
  });
  /**
   * Gaps closed 2026-09-24 on top of the owner decisions: the day's travel re-decided after the
   * day changes (1), Call & Assign on an offer already with that assayer (4), and travel
   * verification measured from the previous branch of the day (6).
   */
  describe('lifecycle gaps 2026-09-24', () => {
    const codeOf = (e: any) => e?.getResponse?.()?.code ?? e?.code;
    const job = (over: any = {}) => ({
      id: 'asn-1', assignmentNumber: 'ASN-1', status: AssignmentStatus.PENDING, assayerId: 'assayer-1',
      scheduledDate: '2026-10-05', createdBy: 'ops-creator',
      projectBranch: { id: 'pb-1', projectId: 'p-1', status: ProjectBranchStatus.PLANNING, isActive: true, branch: { name: 'Kochi', state: 'KL' } },
      ...over,
    });
    const pairsOf = (call = 0) => (mockDayTravel.rebalanceMany.mock.calls as any[])[call]?.[0];

    describe('1 — the day\'s travel is re-decided after a committed change', () => {
      it('a decline re-decides that assayer\'s day, after the transaction', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(job());
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
        const order: string[] = [];
        mockUnitOfWork.run.mockImplementationOnce(async (work: any) => { const r = await (mockUnitOfWork.run as any).getMockImplementation()!(work); order.push('commit'); return r; });
        mockDayTravel.rebalanceMany.mockImplementationOnce(async () => { order.push('rebalance'); });
        await service.rejectOffer('asn-1', 'ops-1', 'Too far');
        expect(pairsOf()).toEqual([{ assayerId: 'assayer-1', day: '2026-10-05' }]);
        expect(order).toEqual(['commit', 'rebalance']);
      });

      it('a cancellation re-decides that assayer\'s day', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.ACCEPTED }));
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
        await service.cancelAssignment('asn-1', 'ops-1', 'Client withdrew');
        expect(pairsOf()).toEqual([{ assayerId: 'assayer-1', day: '2026-10-05' }]);
      });

      it('an accept that names a new date re-decides both days, the new one with this job arriving', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(job());
        mockAssayerRepo.findOne.mockResolvedValue({ id: 'assayer-1', status: AssayerStatus.ACTIVE, isActive: true, leaves: [] });
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
        await service.acceptOffer('asn-1', 'ops-1', undefined, undefined, { scheduledDate: '2026-10-07' });
        expect(pairsOf()).toEqual([
          { assayerId: 'assayer-1', day: '2026-10-05' },
          { assayerId: 'assayer-1', day: new Date('2026-10-07'), arrivingAssignmentId: 'asn-1' },
        ]);
      });

      it('an accept on the same day re-decides nothing', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(job());
        mockAssayerRepo.findOne.mockResolvedValue({ id: 'assayer-1', status: AssayerStatus.ACTIVE, isActive: true, leaves: [] });
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
        await service.acceptOffer('asn-1', 'ops-1');
        expect(mockDayTravel.rebalanceMany).not.toHaveBeenCalled();
      });

      it('an edit that moves the date re-decides both days; an edit that does not, neither', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(job());
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
        await service.update('asn-1', { scheduledDate: '2026-10-09' }, 'ops-1');
        expect(pairsOf()).toEqual([
          { assayerId: 'assayer-1', day: '2026-10-05' },
          { assayerId: 'assayer-1', day: '2026-10-09', arrivingAssignmentId: 'asn-1' },
        ]);
        mockDayTravel.rebalanceMany.mockClear();
        mockAssignmentRepo.findOne.mockResolvedValue(job());
        await service.update('asn-1', { remarks: 'bring the seal' }, 'ops-1');
        expect(mockDayTravel.rebalanceMany).not.toHaveBeenCalled();
      });

      it('a reschedule re-decides both days', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(job({ status: AssignmentStatus.ACCEPTED }));
        await service.scheduleAudit('asn-1', 'ops-1', '2026-10-12');
        expect(pairsOf()).toEqual([
          { assayerId: 'assayer-1', day: '2026-10-05' },
          { assayerId: 'assayer-1', day: '2026-10-12', arrivingAssignmentId: 'asn-1' },
        ]);
      });
    });

    describe('4 — Call & Assign on a branch whose offer is already with that assayer', () => {
      const setup = () => {
        mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', projectId: 'p-1', status: ProjectBranchStatus.PLANNING, branch: { name: 'Kochi', state: 'KL' }, project: {} });
        mockAssayerRepo.findOne.mockResolvedValue({ id: 'assayer-1', displayName: 'Anu', status: AssayerStatus.ACTIVE, isActive: true, skills: [], certifications: [], leaves: [] });
        const offer = job({ id: 'asn-live', assignmentNumber: 'ASN-9', proposedFee: 1500, agreedFee: 1500, quotedBaseFee: 1200, quotedTravelFee: 300, entityVersion: 1 });
        mockAssignmentRepo.findOne.mockResolvedValue(offer);
        mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));
        return offer;
      };

      it('without the desk confirming: a clear 409, nothing created or changed', async () => {
        setup();
        const err: any = await service.create({ projectBranchId: 'pb-1', assayerId: 'assayer-1', scheduledDate: '2026-10-05' } as any, 'ops-1').catch((e) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect(codeOf(err)).toBe('OFFER_ALREADY_WITH_ASSAYER');
        expect(err.message).toMatch(/already offered to Anu \(ASN-9\)/);
        expect(err.message).toMatch(/Call & Assign/);
        expect(mockUnitOfWork.run).not.toHaveBeenCalled();
        expect(mockNotificationDispatch.emitSafe).not.toHaveBeenCalled();
      });

      it('with the desk confirming: the accept runs on that offer, at the typed fee, and it is returned', async () => {
        setup();
        const result: any = await service.create({
          projectBranchId: 'pb-1', assayerId: 'assayer-1', scheduledDate: '2026-10-05', proposedFee: 1800, acceptOnBehalf: true,
        } as any, 'ops-1');
        expect(result.id).toBe('asn-live');
        expect(result.status).toBe(AssignmentStatus.ACCEPTED);
        // The desk's number is the fee, on both columns.
        expect(result.agreedFee).toBe(1800);
        expect(result.proposedFee).toBe(1800);
        // No new offer: no assignment number drawn, no ASSIGNMENT_OFFERED.
        expect(mockAssignmentRepo.create).not.toHaveBeenCalled();
        const types = mockNotificationDispatch.emitSafe.mock.calls.map((c: any[]) => c[0].type);
        expect(types).toContain('ASSIGNMENT_DESK_CONFIRMED');
        expect(types).not.toContain('ASSIGNMENT_OFFERED');
        expect(types).not.toContain('ASSIGNMENT_ACCEPTED');
      });

      it('with no typed fee, the offer keeps its fee', async () => {
        setup();
        const result: any = await service.create({ projectBranchId: 'pb-1', assayerId: 'assayer-1', acceptOnBehalf: true } as any, 'ops-1');
        expect(result.status).toBe(AssignmentStatus.ACCEPTED);
        expect(result.agreedFee).toBe(1500);
      });

      it('a typed fee over twice the offer\'s quote is refused, and nothing is accepted', async () => {
        setup();
        await expect(service.create({
          projectBranchId: 'pb-1', assayerId: 'assayer-1', proposedFee: 3001, acceptOnBehalf: true,
        } as any, 'ops-1')).rejects.toThrow(/exceeds twice/);
        expect(mockUnitOfWork.run).not.toHaveBeenCalled();
      });

      it('another assayer\'s offer is still BRANCH_HAS_LIVE_OFFER, even when the desk confirms', async () => {
        setup();
        mockAssignmentRepo.findOne.mockResolvedValue(job({ id: 'asn-live', assayerId: 'someone-else' }));
        const err: any = await service.create({ projectBranchId: 'pb-1', assayerId: 'assayer-1', acceptOnBehalf: true } as any, 'ops-1').catch((e) => e);
        expect(codeOf(err)).toBe('BRANCH_HAS_LIVE_OFFER');
      });
    });

    describe('6 — travel verification measures a later visit from the previous branch of the day', () => {
      const checkedIn = (over: any = {}) => job({
        status: AssignmentStatus.CHECKED_IN,
        checkedInAt: new Date('2026-10-05T08:00:00Z'),
        quotedDistanceKm: 42, quotedDistanceSource: 'OSRM',
        assayer: { id: 'assayer-1', isLiveEnabled: true, homeLatitude: 10.0, homeLongitude: 76.0 },
        projectBranch: { id: 'pb-1', branch: { name: 'Kochi', latitude: 10.2, longitude: 76.3 } },
        ...over,
      });
      let earlier: any[];
      beforeEach(() => {
        earlier = [];
        (mockAssignmentRepo as any).manager = { query: jest.fn(async () => earlier) };
      });
      afterEach(() => { delete (mockAssignmentRepo as any).manager; });

      it('the day\'s first visit: the home baseline the quote priced', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(checkedIn());
        const r = await service.getTravelVerification('asn-1');
        expect(r).toMatchObject({ expectedBaseline: 'HOME', expectedDistanceKm: 42, expectedDistanceSource: 'OSRM', expectedIsRecomputed: false, previousVisit: null });
        expect(mockRoutingService.calculateRoute).not.toHaveBeenCalled();
      });

      it('a second visit: routed previous branch → this branch, and the response says so', async () => {
        earlier = [{ left_at: '2026-10-05T06:30:00Z', id: 'asn-0', assignment_number: 'ASN-0', latitude: '10.10', longitude: '76.20' }];
        mockAssignmentRepo.findOne.mockResolvedValue(checkedIn());
        mockRoutingService.calculateRoute.mockResolvedValueOnce({ distanceKm: 14.5, durationMinutes: 25, source: 'OSRM' });
        const r = await service.getTravelVerification('asn-1');
        expect(mockRoutingService.calculateRoute).toHaveBeenCalledWith({ latitude: 10.1, longitude: 76.2 }, { latitude: 10.2, longitude: 76.3 });
        expect(r).toMatchObject({
          expectedBaseline: 'PREVIOUS_BRANCH', expectedDistanceKm: 14.5, expectedDistanceSource: 'OSRM', expectedIsRecomputed: true,
          previousVisit: { assignmentId: 'asn-0', assignmentNumber: 'ASN-0' },
        });
        // And the trail is still read from the earlier departure.
        expect(mockLocationTrail.assessAssignmentTravel).toHaveBeenCalledWith(expect.objectContaining({
          expectedDistanceKm: 14.5, notBefore: new Date('2026-10-05T06:30:00Z'),
        }));
      });

      it('router down: a straight line from the previous branch, labelled ESTIMATE', async () => {
        earlier = [{ left_at: '2026-10-05T06:30:00Z', id: 'asn-0', assignment_number: 'ASN-0', latitude: 10.1, longitude: 76.2 }];
        mockAssignmentRepo.findOne.mockResolvedValue(checkedIn());
        mockRoutingService.calculateRoute.mockRejectedValueOnce(new Error('osrm down'));
        const r = await service.getTravelVerification('asn-1');
        expect(r.expectedBaseline).toBe('PREVIOUS_BRANCH');
        expect(r.expectedDistanceSource).toBe('ESTIMATE');
        expect(r.expectedDistanceKm).toBeGreaterThan(10);
        expect(r.expectedDistanceKm).toBeLessThan(20);
      });

      it('a previous branch with no coordinates falls back to the home baseline', async () => {
        earlier = [{ left_at: '2026-10-05T06:30:00Z', id: 'asn-0', assignment_number: 'ASN-0', latitude: null, longitude: null }];
        mockAssignmentRepo.findOne.mockResolvedValue(checkedIn());
        const r = await service.getTravelVerification('asn-1');
        expect(r).toMatchObject({ expectedBaseline: 'HOME', expectedDistanceKm: 42, previousVisit: null });
      });
    });
  });
});
