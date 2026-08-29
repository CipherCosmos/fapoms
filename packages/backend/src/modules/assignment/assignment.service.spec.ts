import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentStatus, ProjectBranchStatus, EventCategory, Priority } from '@fapoms/shared';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssayerService } from '../assayer/assayer.service';
import { LocationTrailService } from '../assayer/location-trail.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
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
    getActiveCommercialProfile: jest.fn().mockResolvedValue({ baseFee: 1500 }),
  };

  /** The movement trail a check-in anchors. Asserted on in the check-in tests below. */
  const mockLocationTrail = {
    record: jest.fn().mockResolvedValue(undefined),
    ingest: jest.fn().mockResolvedValue({ accepted: 1, duplicates: 0, rejected: [] }),
    assessAssignmentTravel: jest.fn().mockResolvedValue(null),
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
      save: jest.fn((arg) => Promise.resolve(arg)),
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn(),
        save: jest.fn((arg) => Promise.resolve(arg)),
        create: jest.fn((arg) => arg),
      }),
    })),
    getRepository: jest.fn((target: any) =>
      target === 'schedules' || target === ScheduleEntity ? mockScheduleRepoViaDataSource : mockUserRepoViaDataSource,
    ),
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

  const mockUnitOfWork = {
    run: jest.fn(async (work: any) =>
      work(
        {
          save: jest.fn((arg: any) => Promise.resolve(arg)),
          // The assignment-number sequence returns a fixed value so the number is deterministic.
          // The transition path's `SELECT … FOR UPDATE` compare-and-swap re-reads the row inside
          // the transaction; here it is served from whatever the repository's findOne last
          // resolved for that id — the same object the service holds, whose status has already
          // been advanced to the target, which the guard accepts as "the same transition".
          query: jest.fn(async (sql: string, params?: any[]) => {
            if (/nextval\('assignment_number_seq'\)/.test(sql)) return [{ n: '42' }];
            if (/FOR UPDATE/.test(sql)) {
              const results = mockAssignmentRepo.findOne.mock.results;
              let fallback: any = null;
              for (let i = results.length - 1; i >= 0; i--) {
                const v = await Promise.resolve(results[i]?.value).catch(() => null);
                if (!v) continue;
                if (params?.[0] != null && v.id === params[0]) return [{ status: v.status }];
                fallback = fallback ?? v;
              }
              return fallback ? [{ status: fallback.status }] : [];
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

  const mockConstraintEvaluator = {
    checkDoubleBooking: jest.fn().mockResolvedValue({ passed: true }),
    checkLeaves: jest.fn().mockReturnValue({ passed: true }),
    checkProjectTimeline: jest.fn().mockReturnValue({ passed: true }),
    checkHoliday: jest.fn().mockResolvedValue({ passed: true }),
    checkDateAvailability: jest.fn().mockResolvedValue({ passed: true }),
    checkDistancePolicy: jest.fn().mockReturnValue({ passed: true }),
    checkSkillsAndCertifications: jest.fn().mockReturnValue({ passed: true }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          // Rules are enforced unless an administrator suspends them — see
          // modules/platform/rule-bypass. Nothing is suspended here, which is the state these
          // tests are actually about.
          provide: RuleBypassService,
          useValue: { isBypassedSync: () => false, isBypassed: async () => false, noteBypass: () => undefined },
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
  });

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
      expect(assignment.projectBranch.status).toBe(ProjectBranchStatus.ASSIGNMENT_CONFIRMED);
      // Confirming via the real ProjectBranchStateMachine (not a raw status mutation) must
      // also publish the domain event so real-time subscribers get notified.
      expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith(
        'ProjectBranchAssignmentConfirmedEvent',
        expect.objectContaining({ aggregateId: 'pb-1' }),
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

    it('quotes base fee only for a second branch on the same day', async () => {
      setup();
      mockAssignmentRepo.findOne.mockResolvedValue({ id: 'asn-existing', assayerId: 'as-1' });

      await service.create({ projectBranchId: 'pb-1', assayerId: 'as-1', proposedFee: 500, scheduledDate: '2026-08-20' } as any, 'user-1');

      const quoteArgs = mockFeePolicyService.quote.mock.calls.at(-1)?.[0];
      expect(quoteArgs.distanceKm).toBe(0);
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
      mockFeePolicyService.quote.mockResolvedValueOnce({
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

      const res = await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'ops-1');

      expect(res.success).toBe(true);
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

      const res = await service.recordCheckIn('asn-1', 28.6315, 77.2167, undefined, 'ops-1');

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
      mockScheduleRepoViaDataSource.save.mockClear();
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValue({ passed: true });
    });

    it('writes the calendar entry when the date is available', async () => {
      await acceptFlow().catch(() => undefined);
      expect(mockConstraintEvaluator.checkDateAvailability).toHaveBeenCalled();
      expect(mockScheduleRepoViaDataSource.save).toHaveBeenCalled();
    });

    it('writes NO calendar entry when the date is refused', async () => {
      // Before the gate, this wrote a CONFIRMED dispatch on a day the assayer was on leave, on a
      // client holiday, or outside the project timeline — the exact conditions the check exists
      // for — and told nobody.
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValue({
        passed: false, reason: 'Assayer is on approved leave on 2026-09-01.',
      });
      await acceptFlow().catch(() => undefined);
      expect(mockScheduleRepoViaDataSource.save).not.toHaveBeenCalled();
    });

    it('still accepts the offer when the date is refused', async () => {
      // The assayer said yes. A calendar clash is the desk's problem to place, not a reason to
      // silently un-accept a job someone has committed to.
      mockConstraintEvaluator.checkDateAvailability.mockResolvedValue({ passed: false, reason: 'Client holiday.' });
      const result = await acceptFlow();
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
    });

    it('survives the availability check throwing outright, without losing the acceptance', async () => {
      // A synchronous throw used to escape the promise-only handler and roll the acceptance back
      // to PENDING — the assayer's "yes" vanished because a calendar lookup failed.
      mockConstraintEvaluator.checkDateAvailability.mockImplementation(() => { throw new Error('db down'); });
      const result = await acceptFlow();
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(mockScheduleRepoViaDataSource.save).not.toHaveBeenCalled();
    });
  });
});
