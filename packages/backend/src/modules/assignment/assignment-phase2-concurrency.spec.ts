import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { AssignmentService } from './assignment.service';
import { AssignmentController } from './assignment.controller';
import { AssignmentEntity } from './assignment.entity';
import { AssignmentReassignmentEntity } from './assignment-reassignment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import {
  AssignmentStatus,
  ProjectBranchStatus,
  EventCategory,
  Priority,
  businessTodayDateKey,
  AssayerStatus,
  AssayerLifecycleStatus,
} from '@fapoms/shared';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssayerService, hashAssayerCreationRequest } from '../assayer/assayer.service';
import { LocationTrailService } from '../assayer/location-trail.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { CacheService } from '../../infrastructure/cache/cache.service';
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
import { OperationalIntegrityService } from './operational-integrity.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from '../assayer/workforce-attribute.entity';
import { AssayerRemarkEntity } from '../assayer/assayer-remark.entity';
import { AssayerActivityEntity } from '../assayer/assayer-activity.entity';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { RosterRecordsService } from '../assayer/roster-records.service';
import { BranchService } from '../branch/branch.service';
import { BranchEntity } from '../branch/branch.entity';
import { BranchContactEntity } from '../branch/branch-contact.entity';
import { BranchDocumentEntity } from '../branch/branch-document.entity';
import { ZoneEntity } from '../zone/zone.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';
import { ClientService } from '../client/client.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { GeoPrecisionService } from '../geo/geo-precision.service';

describe('Phase 2 — Concurrency, State Integrity & Failure Tolerance Test Suite (Races A–L)', () => {
  let assignmentService: AssignmentService;
  let assignmentController: AssignmentController;
  let operationalIntegrityService: OperationalIntegrityService;

  // In-memory repositories and state tracking
  let assignmentsDb: Map<string, any>;
  let reassignmentsDb: any[];
  let auditLogs: any[];
  let publishedOutboxEvents: any[];
  let branchesDb: Map<string, any>;
  let assayersDb: Map<string, any>;

  const mockAuditService = {
    recordEvent: jest.fn(async (dto: any) => {
      auditLogs.push(dto);
      return dto;
    }),
    recordEventSafe: jest.fn(async (dto: any) => {
      auditLogs.push(dto);
      return dto;
    }),
  };

  const mockDomainEventPublisher = {
    publish: jest.fn(async (eventName: string, payload: any) => {
      publishedOutboxEvents.push({ eventName, payload });
    }),
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

  const mockLocationTrail = {
    record: jest.fn().mockResolvedValue(undefined),
    ingest: jest.fn().mockResolvedValue({ accepted: 1, duplicates: 0, rejected: [] }),
    assessAssignmentTravel: jest.fn().mockResolvedValue(null),
  };

  const mockRoutingService = {
    calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 5, durationMinutes: 10 }),
  };

  const mockFeePolicyService = {
    quote: jest.fn().mockResolvedValue({
      baseFee: 1200,
      branchCount: 1,
      baseComponent: 1200,
      distanceKm: 0,
      chargeableKm: 0,
      travelFee: 0,
      total: 1200,
      usedFallbackBaseFee: false,
      rates: { travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true },
    }),
    getRates: jest.fn().mockResolvedValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true }),
    ratesFromConfiguration: jest.fn().mockReturnValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: true }),
    resolveBaseFee: jest.fn().mockResolvedValue({ baseFee: 1200, usedFallback: false }),
    calculateTravelFee: jest.fn().mockReturnValue({ chargeableKm: 0, travelFee: 0 }),
    resolveClientIdForProject: jest.fn().mockResolvedValue(null),
  };

  const mockProjectService = {
    initiateBranchPlanning: jest.fn(),
    confirmBranchAssignment: jest.fn(),
    scheduleBranchAudit: jest.fn(),
    completeBranchAudit: jest.fn(),
    closeBranchProject: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn(async (options: any) => {
      const id = typeof options?.where?.id === 'string' ? options.where.id : options;
      return branchesDb.get(id) || null;
    }),
    save: jest.fn(async (entity: any) => {
      branchesDb.set(entity.id, { ...entity });
      return entity;
    }),
  };

  const mockAssignmentRepo = {
    create: jest.fn((dto: any) => ({
      id: `asg-${Date.now()}-${Math.random()}`,
      entityVersion: 1,
      isActive: true,
      ...dto,
    })),
    save: jest.fn(async (entity: any) => {
      const existing = assignmentsDb.get(entity.id) || {};
      const updated = { ...existing, ...entity };
      assignmentsDb.set(entity.id, updated);
      return updated;
    }),
    findOne: jest.fn(async (options: any) => {
      const id = typeof options?.where?.id === 'string' ? options.where.id : options;
      if (typeof id === 'string') {
        const row = assignmentsDb.get(id);
        return row ? { ...row } : null;
      }
      if (options?.where?.assayerId && options?.where?.scheduledDate) {
        for (const a of assignmentsDb.values()) {
          if (a.assayerId === options.where.assayerId && a.scheduledDate === options.where.scheduledDate && a.isActive) {
            return { ...a };
          }
        }
      }
      return null;
    }),
    find: jest.fn(async () => Array.from(assignmentsDb.values())),
    findAndCount: jest.fn(async () => [Array.from(assignmentsDb.values()), assignmentsDb.size]),
    count: jest.fn(async () => assignmentsDb.size),
    // The pre-tx idempotency check uses this.assignmentRepository.manager.query
    get manager() { return { query: (...args: any[]) => mockDataSource.query(...args) }; },
  };

  const mockReassignmentRepo = {
    create: jest.fn((dto: any) => ({
      id: `reassign-${Date.now()}-${Math.random()}`,
      ...dto,
    })),
    save: jest.fn(async (entity: any) => {
      reassignmentsDb.push(entity);
      return entity;
    }),
    find: jest.fn(async (options: any) => {
      const assignmentId = options?.where?.assignmentId;
      return reassignmentsDb.filter((r) => !assignmentId || r.assignmentId === assignmentId);
    }),
  };

  const mockAssayerRepo = {
    findOne: jest.fn(async (options: any) => {
      const id = typeof options?.where?.id === 'string' ? options.where.id : options;
      return assayersDb.get(id) || {
        id,
        status: AssayerStatus.ACTIVE,
        lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
        isActive: true,
      };
    }),
    save: jest.fn(async (entity: any) => {
      assayersDb.set(entity.id, { ...entity });
      return entity;
    }),
    find: jest.fn(async () => Array.from(assayersDb.values())),
  };

  const mockDataSource: any = {
    transaction: jest.fn(async (cb: any) => {
      return cb(mockEntityManager);
    }),
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (/nextval\('assignment_number_seq'\)/.test(sql)) {
        return [{ n: '99001' }];
      }
      if (/FOR UPDATE/.test(sql)) {
        const id = params?.[0];
        const row = assignmentsDb.get(id);
        if (row) {
          return [{
            status: row.status,
            entity_version: row.entityVersion ?? 1,
            assayer_id: row.assayerId,
          }];
        }
        return [];
      }
      /**
       * The read-back `reassignAssignment` performs after its save, to confirm the row actually
       * moved before it records anything. Answering it from `assignmentsDb` — the same map
       * `save()` writes into — is what makes this fake behave like a database rather than like a
       * promise that resolves: a reassignment that did not take is visible here, which is
       * precisely the property the production code now depends on.
       */
      if (/SELECT assayer_id, entity_version, status FROM assignments/.test(sql)) {
        const row = assignmentsDb.get(params?.[0]);
        return row
          ? [{ assayer_id: row.assayerId, entity_version: row.entityVersion ?? 1, status: row.status }]
          : [];
      }
      return [];
    }),
    getRepository: jest.fn((entity: any) => {
      if (entity === AssignmentReassignmentEntity) return mockReassignmentRepo;
      if (entity === AssignmentEntity) return mockAssignmentRepo;
      if (entity === AssayerEntity) return mockAssayerRepo;
      if (entity === ProjectBranchEntity) return mockProjectBranchRepo;
      return mockAssignmentRepo;
    }),
  };

  const mockEntityManager: any = {
    create: jest.fn((entityClass: any, dto: any) => ({ ...dto })),
    save: jest.fn(async (entity: any) => {
      if (entity?.assayerId && entity?.status) {
        return mockAssignmentRepo.save(entity);
      }
      if (entity?.previousAssayerId) {
        return mockReassignmentRepo.save(entity);
      }
      return entity;
    }),
    findOne: jest.fn(async (entityClass: any, opts: any) => {
      if (entityClass === AssignmentEntity) return mockAssignmentRepo.findOne(opts);
      if (entityClass === AssayerEntity) return mockAssayerRepo.findOne(opts);
      return null;
    }),
    getRepository: jest.fn((entity: any) => mockDataSource.getRepository(entity)),
    query: jest.fn(async (sql: string, params?: any[]) => mockDataSource.query(sql, params)),
  };

  const mockUnitOfWork = {
    run: jest.fn(async (work: any) => {
      const emit = (eventOrName: any, payload?: any) => {
        if (typeof eventOrName === 'string') {
          publishedOutboxEvents.push({ eventName: eventOrName, payload });
        } else {
          publishedOutboxEvents.push(eventOrName);
        }
      };
      return work(mockEntityManager, emit);
    }),
  };

  beforeEach(async () => {
    assignmentsDb = new Map();
    reassignmentsDb = [];
    auditLogs = [];
    publishedOutboxEvents = [];
    branchesDb = new Map();
    assayersDb = new Map();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentService,
        AssignmentController,
        OperationalIntegrityService,
        {
          provide: RegionGuardService,
          useValue: {
            assertAssignmentInScope: jest.fn().mockResolvedValue(undefined),
            assertBranchAccess: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: getRepositoryToken(AssignmentReassignmentEntity), useValue: mockReassignmentRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: UnitOfWork, useValue: mockUnitOfWork },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: NotificationDispatchService, useValue: mockNotificationDispatch },
        { provide: PushNotificationService, useValue: mockPushNotificationService },
        { provide: LocationTrailService, useValue: mockLocationTrail },
        { provide: RoutingService, useValue: mockRoutingService },
        { provide: FeePolicyService, useValue: mockFeePolicyService },
        { provide: ProjectService, useValue: mockProjectService },
        {
          provide: ProjectQueryService,
          useValue: { findProjectBranchById: mockProjectBranchRepo.findOne },
        },
        {
          provide: AssayerService,
          useValue: {
            findOne: mockAssayerRepo.findOne,
            updateAssayerStats: jest.fn(),
            scheduleStatsRefresh: jest.fn(),
            enableLiveTrackingForActiveWork: jest.fn(),
            disableLiveTrackingWhenWorkEnds: jest.fn(),
            getActiveCommercialProfile: jest.fn().mockResolvedValue({ baseFee: 1500 }),
          },
        },
        {
          provide: HolidayService,
          useValue: { isHoliday: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: CacheService,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
        },
        {
          provide: OperationsInboxService,
          useValue: { markPendingConfirmation: jest.fn(), resolveConfirmation: jest.fn() },
        },
        {
          provide: ConstraintEvaluator,
          useValue: {
            evaluateConstraints: jest.fn().mockResolvedValue({ eligible: true }),
            checkSkillsAndCertifications: jest.fn().mockReturnValue({ passed: true }),
            checkDistancePolicy: jest.fn().mockReturnValue({ passed: true }),
            checkDateAvailability: jest.fn().mockResolvedValue({ passed: true }),
            checkDoubleBooking: jest.fn(async (assayerId: string, date: any) => {
              const dateKey = typeof date === 'string' ? date : date?.toISOString ? date.toISOString().split('T')[0] : String(date);
              for (const a of assignmentsDb.values()) {
                if (a.assayerId === assayerId && a.isActive) {
                  const aDateKey = typeof a.scheduledDate === 'string' ? a.scheduledDate : a.scheduledDate?.toISOString ? a.scheduledDate.toISOString().split('T')[0] : String(a.scheduledDate);
                  if (aDateKey === dateKey) {
                    return { passed: false, reason: `Assayer is already booked on ${dateKey}` };
                  }
                }
              }
              return { passed: true };
            }),
          },
        },
        {
          provide: ValidationService,
          useValue: { validateAssignment: jest.fn() },
        },
        {
          provide: DocumentService,
          useValue: { generateAssignmentDocument: jest.fn() },
        },
        {
          provide: RuleBypassService,
          useValue: { checkBypass: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: PlatformSettingsService,
          useValue: {
            getSettings: jest.fn().mockResolvedValue({ maxNegotiationRounds: 0 }),
            getNumber: jest.fn().mockResolvedValue(500),
          },
        },
        /**
         * These suites are about concurrency and command authority, not client eligibility, so
         * the policy is stubbed permissive. Its own enforcement is covered by
         * `assignment-target-eligibility.policy.spec.ts` and by the live matrix run against both
         * write paths — a stub here would hide nothing that those do not pin.
         */
        {
          provide: AssignmentTargetEligibilityService,
          useValue: {
            evaluate: jest.fn().mockResolvedValue({
              outcome: 'ALLOWED', standing: 'ACTIVE', empanelmentId: null, empanelmentEffectiveAt: null,
            }),
            resolveBlock: jest.fn(),
            assertMayOverride: jest.fn(),
          },
        },
        {
          provide: BillingEngineService,
          useValue: {
            recordDisbursement: jest.fn(),
            voidPayable: jest.fn(),
          },
        },
      ],
    }).compile();

    assignmentService = module.get<AssignmentService>(AssignmentService);
    assignmentController = module.get<AssignmentController>(AssignmentController);
    operationalIntegrityService = module.get<OperationalIntegrityService>(OperationalIntegrityService);
  });

  describe('Race A — Accept vs Reassign', () => {
    it('protects assignment with row lock, records historical lineage, and prevents stale assignee accept', async () => {
      const assignmentId = 'asg-race-a';
      const initialAssayerId = 'assayer-1';
      const newAssayerId = 'assayer-2';

      // Seed assignment in PENDING status
      const assignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-001',
        status: AssignmentStatus.PENDING,
        assayerId: initialAssayerId,
        projectBranchId: 'pb-1',
        entityVersion: 1,
        isActive: true,
        scheduledDate: '2026-09-10',
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.PLANNING },
      };
      assignmentsDb.set(assignmentId, assignment);

      // Seed assayers
      assayersDb.set(initialAssayerId, { id: initialAssayerId, status: 'ACTIVE', isActive: true });
      assayersDb.set(newAssayerId, { id: newAssayerId, status: 'ACTIVE', isActive: true });

      // Desk reassigns to new assayer
      const reassigned = await assignmentService.reassignAssignment(
        assignmentId,
        newAssayerId,
        'ops-user-1',
        'Original assayer unwell',
      );

      // 1. Lineage record was persisted in assignment_reassignments
      expect(reassignmentsDb.length).toBe(1);
      const lineage = reassignmentsDb[0];
      expect(lineage.assignmentId).toBe(assignmentId);
      expect(lineage.previousAssayerId).toBe(initialAssayerId);
      expect(lineage.newAssayerId).toBe(newAssayerId);
      expect(lineage.reassignedBy).toBe('ops-user-1');
      expect(lineage.reason).toBe('Original assayer unwell');
      expect(lineage.ownershipEndedAt).toBeDefined();

      // 2. Authoritative assignment state has updated assayerId and bumped entityVersion
      expect(reassigned.assayerId).toBe(newAssayerId);
      expect(reassigned.entityVersion).toBe(2);

      // 3. Stale original assayer tries to accept the reassigned assignment
      await expect(
        assignmentService.acceptOffer(assignmentId, initialAssayerId, undefined, undefined, {
          expectedVersion: 1,
          isAssayerRole: true,
        }),
      ).rejects.toThrow(ForbiddenException);

      // Verify the assignment remains assigned to Assayer 2 and was not corrupted
      const authoritative = assignmentsDb.get(assignmentId);
      expect(authoritative.assayerId).toBe(newAssayerId);
      expect(authoritative.entityVersion).toBe(2);
    });
  });

  describe('Race B — Schedule vs Schedule (Double Booking Invariant)', () => {
    it('deterministically rejects concurrent double booking for the same assayer on the same calendar day', async () => {
      const assayerId = 'assayer-busy';
      const scheduledDate = '2026-09-12';

      assayersDb.set(assayerId, {
        id: assayerId,
        status: 'ACTIVE',
        isActive: true,
        skills: ['GOLD'],
      });

      branchesDb.set('pb-2', {
        id: 'pb-2',
        status: ProjectBranchStatus.PLANNING,
        isActive: true,
        branch: { state: 'MH' },
      });

      // Existing active assignment on the same date
      const existingAssignment: any = {
        id: 'asg-existing',
        assayerId,
        scheduledDate,
        status: AssignmentStatus.ACCEPTED,
        isActive: true,
      };
      assignmentsDb.set(existingAssignment.id, existingAssignment);

      // Attempting to schedule a second assignment on the same day throws ConflictException
      await expect(
        assignmentService.create({
          projectBranchId: 'pb-2',
          assayerId,
          scheduledDate,
        } as any, 'ops-user'),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('Race C — Check-in vs Cancel (No Resurrection)', () => {
    it('refuses check-in on a CANCELLED assignment and never resurrects cancelled state', async () => {
      const assignmentId = 'asg-cancelled';
      const assayerId = 'assayer-c';

      const cancelledAssignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-C',
        status: AssignmentStatus.CANCELLED,
        cancelReason: 'Client branch closed',
        assayerId,
        entityVersion: 3,
        isActive: true,
        checkedInAt: null,
      };
      assignmentsDb.set(assignmentId, cancelledAssignment);

      // Attempting to check in to a CANCELLED assignment must return refusal with ASSIGNMENT_CANCELLED
      const checkInResult = await assignmentService.recordCheckIn(
        assignmentId,
        19.076,
        72.8777,
        undefined,
        assayerId,
      );
      expect(checkInResult.success).toBe(false);
      expect(checkInResult.error).toBe('ASSIGNMENT_CANCELLED');

      // Verify assignment status is still CANCELLED and checkedInAt remains null
      const authoritative = assignmentsDb.get(assignmentId);
      expect(authoritative.status).toBe(AssignmentStatus.CANCELLED);
      expect(authoritative.checkedInAt).toBeNull();

      // No status-change outbox event was emitted
      const resurrectedEvents = publishedOutboxEvents.filter(
        (e) => e.eventName === 'assignment:status-changed' && e.payload?.assignmentId === assignmentId,
      );
      expect(resurrectedEvents.length).toBe(0);
    });
  });

  describe('Race D — Duplicate Concurrent Check-in', () => {
    it('safely and idempotently handles duplicate check-in without rewriting or duplicate transition events', async () => {
      const assignmentId = 'asg-checkin-idempotent';
      const assayerId = 'assayer-d';

      const initialAssignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-D',
        status: AssignmentStatus.ACCEPTED,
        assayerId,
        scheduledDate: businessTodayDateKey(),
        entityVersion: 2,
        isActive: true,
        projectBranch: {
          id: 'pb-d',
          latitude: 19.076,
          longitude: 72.8777,
          branch: { latitude: 19.076, longitude: 72.8777 },
        },
      };
      assignmentsDb.set(assignmentId, initialAssignment);

      // First check-in
      const firstResult = await assignmentService.recordCheckIn(
        assignmentId,
        19.076,
        72.8777,
        undefined,
        assayerId,
      );
      expect(firstResult.success).toBe(true);
      expect(firstResult.assignment.status).toBe(AssignmentStatus.CHECKED_IN);
      expect(firstResult.assignment.checkedInAt).toBeDefined();
      expect(firstResult.assignment.entityVersion).toBe(3);

      const eventsAfterFirst = publishedOutboxEvents.length;

      // Second identical check-in (concurrent retry or network replay)
      const secondResult = await assignmentService.recordCheckIn(
        assignmentId,
        19.076,
        72.8777,
        undefined,
        assayerId,
      );

      // Safe idempotent return of existing authoritative state
      expect(secondResult.success).toBe(true);
      expect(secondResult.assignment.status).toBe(AssignmentStatus.CHECKED_IN);
      expect(secondResult.assignment.checkedInAt).toEqual(firstResult.assignment.checkedInAt);
      expect(secondResult.assignment.entityVersion).toBe(3);

      // No second outbox transition event was emitted
      expect(publishedOutboxEvents.length).toBe(eventsAfterFirst);
    });
  });

  describe('Race E — Stale Mobile Command vs Newer Server State', () => {
    it('rejects stale mobile command with STALE_ASSIGNMENT_VERSION conflict when expectedVersion < entityVersion', async () => {
      const assignmentId = 'asg-stale-concurrency';
      const assayerId = 'assayer-e';

      /**
       * Server assignment is at version 10, and CHECKED_IN.
       *
       * CHECKED_IN rather than ACCEPTED because the command below targets IN_PROGRESS, and
       * `VALID_PATHS` only allows work to start from a check-in — the check-in is geofenced, so
       * "in progress" is meant to mean somebody is actually at the branch.
       *
       * This fixture said ACCEPTED until the IN_PROGRESS branch of `executeAssignmentTransition`
       * was made to consult the state machine at all. It had been assigning the column directly,
       * so an illegal edge sailed through to the version check and this test passed for the wrong
       * reason — it was measuring the absence of a control, not the presence of the one it names.
       * With a legal edge the stale-version conflict is what actually refuses the command, which
       * is what the test is about.
       */
      const serverAssignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-E',
        status: AssignmentStatus.CHECKED_IN,
        assayerId,
        entityVersion: 10,
        isActive: true,
        projectBranch: { id: 'pb-e' },
      };
      assignmentsDb.set(assignmentId, serverAssignment);

      // Mobile sends command with expectedVersion = 8
      let thrownError: any = null;
      try {
        await (assignmentService as any).executeAssignmentTransition(
          assignmentId,
          AssignmentStatus.IN_PROGRESS,
          assayerId,
          undefined,
          undefined,
          {
            expectedVersion: 8,
            clientRequestId: 'req-stale-8',
          },
        );
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(ConflictException);
      expect(thrownError.message).toContain('STALE_ASSIGNMENT_VERSION');

      // Verify server assignment version is still 10 and status is not changed
      const authoritative = assignmentsDb.get(assignmentId);
      expect(authoritative.entityVersion).toBe(10);
      // Unchanged — the refusal must leave the server's own state exactly where it was, which is
      // where this fixture starts (see the note on the fixture above for why that is CHECKED_IN).
      expect(authoritative.status).toBe(AssignmentStatus.CHECKED_IN);
    });
  });

  describe('Race F — Concurrent Completion', () => {
    it('completes once, and second concurrent completion idempotently returns completed state without duplicate side-effects', async () => {
      const assignmentId = 'asg-complete-race';
      const assayerId = 'assayer-f';

      const assignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-F',
        status: AssignmentStatus.IN_PROGRESS,
        assayerId,
        entityVersion: 4,
        isActive: true,
        checkedInAt: new Date(),
        projectBranch: { id: 'pb-f', isActive: true, status: ProjectBranchStatus.SCHEDULED },
      };
      assignmentsDb.set(assignmentId, assignment);

      // First completion succeeds
      const first = await assignmentService.completeAssignment(
        assignmentId,
        assayerId,
        'Audit completed successfully',
      );
      expect(first.status).toBe(AssignmentStatus.COMPLETED);
      expect(first.completionDate).toBe(businessTodayDateKey());
      expect(first.entityVersion).toBe(5);

      const outboxCount = publishedOutboxEvents.length;

      // Second concurrent completion call
      const second = await assignmentService.completeAssignment(
        assignmentId,
        assayerId,
        'Audit completed successfully retry',
      );

      expect(second.status).toBe(AssignmentStatus.COMPLETED);
      expect(second.entityVersion).toBe(5);
      // No duplicate transition events published
      expect(publishedOutboxEvents.length).toBe(outboxCount);
    });
  });

  describe('Race G — Assayer Status Change vs Assignment Transition', () => {
    it('refuses offer acceptance if assayer becomes SUSPENDED or INACTIVE', async () => {
      const assignmentId = 'asg-suspended-assayer';
      const assayerId = 'assayer-suspended';

      const assignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-G',
        status: AssignmentStatus.PENDING,
        assayerId,
        entityVersion: 1,
        isActive: true,
        projectBranch: { id: 'pb-g' },
      };
      assignmentsDb.set(assignmentId, assignment);

      // Assayer is marked SUSPENDED
      assayersDb.set(assayerId, {
        id: assayerId,
        status: 'SUSPENDED',
        isActive: false,
      });

      // Assayer attempts to accept offer
      await expect(
        assignmentService.acceptOffer(assignmentId, assayerId),
      ).rejects.toThrow(BadRequestException);

      // State remains PENDING
      const authoritative = assignmentsDb.get(assignmentId);
      expect(authoritative.status).toBe(AssignmentStatus.PENDING);
    });
  });

  describe('Race H — Reassignment vs Offline Old-Device Action', () => {
    it('rejects actions from old assayer device once assignment has been reassigned to another assayer', async () => {
      const assignmentId = 'asg-reassigned-offline';
      const oldAssayerId = 'assayer-old';
      const currentAssayerId = 'assayer-new';

      // Assignment was reassigned to Assayer New
      const assignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-H',
        status: AssignmentStatus.ACCEPTED,
        assayerId: currentAssayerId,
        entityVersion: 3,
        isActive: true,
        projectBranch: { id: 'pb-h' },
      };
      assignmentsDb.set(assignmentId, assignment);

      // Old assayer's device comes online and attempts to check-in
      const checkInResult = await assignmentService.recordCheckIn(
        assignmentId,
        19.076,
        72.8777,
        undefined,
        oldAssayerId,
      );
      expect(checkInResult.success).toBe(false);
      expect(checkInResult.error).toBe('NOT_YOUR_ASSIGNMENT');

      // Old assayer attempts transition
      await expect(
        (assignmentService as any).executeAssignmentTransition(
          assignmentId,
          AssignmentStatus.IN_PROGRESS,
          oldAssayerId,
          undefined,
          undefined,
          { assayerId: oldAssayerId },
        ),
      ).rejects.toThrow(ForbiddenException);

      // Assignment remains assigned to currentAssayerId
      const authoritative = assignmentsDb.get(assignmentId);
      expect(authoritative.assayerId).toBe(currentAssayerId);
    });
  });

  describe('Race I — Branch Deactivation vs Active Assignment', () => {
    let testBranchService: BranchService;
    let branchQueryRunnerResults: any[];

    beforeEach(async () => {
      branchQueryRunnerResults = [];
      const mockBranchDataSource = {
        query: jest.fn(async (sql: string, params?: any[]) => {
          if (/FROM assignments a/.test(sql)) {
            return branchQueryRunnerResults;
          }
          if (/UPDATE assignments/.test(sql)) {
            // Apply update to assignmentsDb
            const id = params?.[1];
            const asg = assignmentsDb.get(id);
            if (asg) {
              asg.status = AssignmentStatus.CANCELLED;
              asg.cancelReason = 'Branch deactivated by operations';
            }
            return [];
          }
          return [];
        }),
      };

      const mockBranchRepo = {
        findOne: jest.fn(async () => ({ id: 'branch-1', name: 'Downtown Branch', solId: 'SOL001', isActive: true })),
        save: jest.fn(async (b) => b),
      };

      const branchModule: TestingModule = await Test.createTestingModule({
        providers: [
          BranchService,
          { provide: getRepositoryToken(BranchEntity), useValue: mockBranchRepo },
          { provide: getRepositoryToken(BranchContactEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
          { provide: getRepositoryToken(BranchDocumentEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
          { provide: getRepositoryToken(ZoneEntity), useValue: {} },
          { provide: getRepositoryToken(GeoStateEntity), useValue: {} },
          { provide: getRepositoryToken(GeoDistrictEntity), useValue: {} },
          { provide: getRepositoryToken(GeoCityEntity), useValue: {} },
          { provide: DataSource, useValue: mockBranchDataSource },
          { provide: ClientService, useValue: {} },
          { provide: AuditService, useValue: mockAuditService },
          {
            provide: BranchQueryService,
            useValue: {
              findOne: jest.fn(async () => ({ id: 'branch-1', name: 'Downtown Branch', solId: 'SOL001', isActive: true })),
            },
          },
          { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
          { provide: GeoPrecisionService, useValue: {} },
        ],
      }).compile();

      testBranchService = branchModule.get<BranchService>(BranchService);
    });

    it('blocks branch deactivation with ConflictException when on-site work is CHECKED_IN or IN_PROGRESS', async () => {
      branchQueryRunnerResults = [
        { id: 'asg-active-1', assignment_number: 'ASN-101', status: AssignmentStatus.CHECKED_IN, project_branch_id: 'pb-1' },
      ];

      await expect(testBranchService.remove('branch-1', 'ops-user')).rejects.toThrow(ConflictException);
    });

    it('transactionally cancels PENDING or ACCEPTED assignments and produces outbox and audit events', async () => {
      const asgPending: any = {
        id: 'asg-p-1',
        assignmentNumber: 'ASN-P1',
        status: AssignmentStatus.PENDING,
        entityVersion: 1,
        isActive: true,
      };
      assignmentsDb.set(asgPending.id, asgPending);

      branchQueryRunnerResults = [
        { id: asgPending.id, assignment_number: asgPending.assignmentNumber, status: asgPending.status, project_branch_id: 'pb-1' },
      ];

      await testBranchService.remove('branch-1', 'ops-user');

      // Assignment was cancelled
      expect(asgPending.status).toBe(AssignmentStatus.CANCELLED);
      expect(asgPending.cancelReason).toBe('Branch deactivated by operations');

      // Audit and outbox events were published
      const cancelAudit = auditLogs.find((l) => l.eventType === 'ASSIGNMENT_CANCELLED');
      expect(cancelAudit).toBeDefined();

      const cancelOutbox = publishedOutboxEvents.find((e) => e.eventName === 'assignment:status-changed');
      expect(cancelOutbox).toBeDefined();
      expect(cancelOutbox.payload.assignmentId).toBe(asgPending.id);
    });
  });

  describe('Race J — Assayer Registration Duplicate Handling & Idempotency', () => {
    let testAssayerService: AssayerService;
    let assayersTable: any[];

    beforeEach(async () => {
      assayersTable = [];
      const mockAssayerDataSource = {
        query: jest.fn(async (sql: string, params?: any[]) => {
          if (/assayer_idempotency_records/.test(sql)) {
            const reqId = params?.[0];
            const hit = assayersTable.find((a) => a.notes?.includes(reqId) || a.clientRequestId === reqId);
            if (!hit) return [];
            const hash = hashAssayerCreationRequest({
              fullName: hit.fullName || hit.displayName,
              phone: hit.phone,
              state: 'Maharashtra',
            } as any);
            return [
              {
                command: 'CREATE',
                client_request_id: reqId,
                request_hash: hash,
                response_payload: hit,
              },
            ];
          }
          if (/SELECT id, assayer_code FROM assayers WHERE client_request_id = \$1/.test(sql)) {
            const reqId = params?.[0];
            const hit = assayersTable.find((a) => a.clientRequestId === reqId);
            return hit ? [{ id: hit.id, assayer_code: hit.assayerCode }] : [];
          }
          if (/SELECT id, assayer_code, display_name, phone_number, pan_number/.test(sql)) {
            const phone = params?.[0];
            const pan = params?.[1];
            const hits = assayersTable.filter((a) => {
              const pMatch = phone && a.phoneNumber === phone;
              const panMatch = pan && a.panNumber === pan;
              return pMatch || panMatch;
            });
            return hits.map((h) => ({
              id: h.id,
              assayer_code: h.assayerCode,
              display_name: h.displayName,
              phone_number: h.phoneNumber,
              pan_number: h.panNumber,
            }));
          }
          if (/SELECT assayer_code FROM assayers ORDER BY/.test(sql)) {
            return [];
          }
          return [];
        }),
      };

      const mockAssayerTableRepo = {
        create: jest.fn((dto) => ({ id: `assayer-${Date.now()}`, ...dto })),
        save: jest.fn(async (entity) => {
          assayersTable.push(entity);
          return entity;
        }),
        findOne: jest.fn(async (opts: any) => {
          if (opts?.where?.id) return assayersTable.find((a) => a.id === opts.where.id) || null;
          if (opts?.where?.assayerCode) return assayersTable.find((a) => a.assayerCode === opts.where.assayerCode) || null;
          return null;
        }),
        find: jest.fn(async () => assayersTable),
        manager: mockAssayerDataSource,
      };

      const mockAssayerUow = {
        run: jest.fn(async (work: any) => work(mockEntityManager, jest.fn())),
      };

      const assayerModule: TestingModule = await Test.createTestingModule({
        providers: [
          AssayerService,
          { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerTableRepo },
          { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: { findOne: jest.fn(), save: jest.fn(), create: jest.fn() } },
          { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]), create: jest.fn(), save: jest.fn(), delete: jest.fn() } },
          { provide: getRepositoryToken(AssayerRemarkEntity), useValue: { find: jest.fn().mockResolvedValue([]), create: jest.fn(), save: jest.fn() } },
          { provide: getRepositoryToken(AssayerActivityEntity), useValue: { find: jest.fn().mockResolvedValue([]), create: jest.fn(), save: jest.fn() } },
          { provide: getRepositoryToken(ScheduleEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
          { provide: DataSource, useValue: mockAssayerDataSource },
          { provide: UnitOfWork, useValue: mockAssayerUow },
          { provide: AuditService, useValue: mockAuditService },
          { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
          { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn(), executeCommand: jest.fn() } },
          { provide: EmailProvider, useValue: { send: jest.fn().mockResolvedValue({ success: false }) } },
          { provide: SmsProvider, useValue: { send: jest.fn().mockResolvedValue(false) } },
          { provide: RosterRecordsService, useValue: {} },
          { provide: CacheService, useValue: { del: jest.fn() } },
          { provide: DocumentService, useValue: {} },
          { provide: PlatformSettingsService, useValue: {} },
          { provide: NotificationDispatchService, useValue: mockNotificationDispatch },
          { provide: PushNotificationService, useValue: mockPushNotificationService },
        ],
      }).compile();

      testAssayerService = assayerModule.get<AssayerService>(AssayerService);
    });

    it('returns existing assayer idempotently when duplicate registration has identical clientRequestId', async () => {
      const existing: any = {
        id: 'assayer-req-1',
        assayerCode: 'AS0001',
        fullName: 'Aarav Sharma',
        displayName: 'Aarav Sharma',
        phone: '+919876543210',
        notes: 'clientRequestId:client-req-abc-123',
      };
      assayersTable.push(existing);

      const result = await testAssayerService.create({
        fullName: 'Aarav Sharma',
        displayName: 'Aarav Sharma',
        phone: '9876543210',
        clientRequestId: 'client-req-abc-123',
        state: 'Maharashtra',
      } as any, 'ops-user');

      expect(result.id).toBe(existing.id);
      expect(result.assayerCode).toBe(existing.assayerCode);
      expect(assayersTable.length).toBe(1);
    });

    it('rejects registration as DEFINITE_DUPLICATE when PAN number already exists', async () => {
      assayersTable.push({
        id: 'assayer-pan-exist',
        assayerCode: 'AS0002',
        fullName: 'Rohan Verma',
        displayName: 'Rohan Verma',
        phone: '+919876543211',
        panNumber: 'ABCDE1234F',
      });

      await expect(
        testAssayerService.create({
          fullName: 'Rohan Verma New',
          displayName: 'Rohan Verma New',
          phone: '9876543299',
          panNumber: 'ABCDE1234F',
          state: 'Maharashtra',
        } as any, 'ops-user'),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects registration as PROBABLE_DUPLICATE on shared phone unless allowSharedContact is true', async () => {
      assayersTable.push({
        id: 'assayer-phone-exist',
        assayerCode: 'AS0003',
        fullName: 'Pooja Patel',
        displayName: 'Pooja Patel',
        phone: '+919876543212',
      });

      // Without allowSharedContact: throws ConflictException
      await expect(
        testAssayerService.create({
          fullName: 'Sanjay Patel',
          displayName: 'Sanjay Patel',
          phone: '9876543212',
          allowSharedContact: false,
          state: 'Maharashtra',
        } as any, 'ops-user'),
      ).rejects.toThrow(ConflictException);

      // With allowSharedContact and authorized sharedContactReason: succeeds
      const created = await testAssayerService.create({
        fullName: 'Sanjay Patel',
        displayName: 'Sanjay Patel',
        phone: '9876543212',
        allowSharedContact: true,
        sharedContactReason: 'Legitimate family jewelry shop shared phone',
        state: 'Maharashtra',
      } as any, 'ops-user');

      expect(created).toBeDefined();
      expect(created.displayName).toBe('Sanjay Patel');
    });
  });

  describe('Race K — Retry after DB Success but HTTP Response Failure', () => {
    it('returns authoritative committed state idempotently on client retry', async () => {
      const assignmentId = 'asg-http-fail-retry';
      const assayerId = 'assayer-k';

      // Assignment already reached ACCEPTED in DB
      const committedAssignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-K',
        status: AssignmentStatus.ACCEPTED,
        assayerId,
        entityVersion: 2,
        isActive: true,
        projectBranch: { id: 'pb-k' },
      };
      assignmentsDb.set(assignmentId, committedAssignment);

      // Client retries acceptOffer with same expectedVersion
      const retryResult = await assignmentService.acceptOffer(
        assignmentId,
        assayerId,
        undefined,
        undefined,
        {
          expectedVersion: 1,
          clientRequestId: 'client-req-k-retry',
        },
      );

      expect(retryResult.status).toBe(AssignmentStatus.ACCEPTED);
      expect(retryResult.entityVersion).toBe(2);
    });
  });

  describe('Race L — Worker Crash after DB Commit (Durable Outbox Invariant)', () => {
    it('commits assignment state and outbox event atomically in same unit of work transaction', async () => {
      const assignmentId = 'asg-crash-proof';
      const assayerId = 'assayer-l';

      const assignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-L',
        status: AssignmentStatus.PENDING,
        assayerId,
        entityVersion: 1,
        isActive: true,
        projectBranch: { id: 'pb-l', isActive: true, status: ProjectBranchStatus.PLANNING },
      };
      assignmentsDb.set(assignmentId, assignment);
      assayersDb.set(assayerId, { id: assayerId, status: 'ACTIVE', isActive: true });

      // Accept transition runs within unitOfWork transaction
      await assignmentService.acceptOffer(assignmentId, assayerId);

      // Even if worker process crashed right after DB commit,
      // 1. Assignment is durably in ACCEPTED state
      expect(assignmentsDb.get(assignmentId).status).toBe(AssignmentStatus.ACCEPTED);

      // 2. Outbox event was captured in the same atomic transaction
      const outboxEvent = publishedOutboxEvents.find(
        (e) => e.eventName === 'assignment:status-changed' && e.payload?.assignmentId === assignmentId,
      );
      expect(outboxEvent).toBeDefined();
      expect(outboxEvent.payload.newState).toBe(AssignmentStatus.ACCEPTED);
    });
  });

  describe('Operational Command Model & Reopen Protection', () => {
    /**
     * The generic `POST :id/transition` endpoint allows assayers to drive their own assignment
     * through a limited set of transitions (ACCEPTED, REJECTED, CHECKED_IN, IN_PROGRESS).
     * Every other status change is an operational or administrative action that requires a
     * dedicated command endpoint with its own authorization semantics.
     *
     * These tests prove that the controller-level guards cannot be bypassed by an assayer
     * calling the generic transition endpoint with a privileged target status.
     */

    it('forbids reopening a COMPLETED assignment via the generic transition route', async () => {
      const assignmentId = 'asg-completed-no-reopen';

      const completedAssignment: any = {
        id: assignmentId,
        assignmentNumber: 'ASN-COMP',
        status: AssignmentStatus.COMPLETED,
        entityVersion: 6,
        isActive: true,
      };
      assignmentsDb.set(assignmentId, completedAssignment);

      await expect(
        assignmentController.transition(
          assignmentId,
          { targetStatus: AssignmentStatus.ACCEPTED },
          { user: { id: 'mobile-user', roles: ['ASSAYER'] } },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids an assayer cancelling an assignment via the generic transition route', async () => {
      const assignmentId = 'asg-assayer-cancel';
      assignmentsDb.set(assignmentId, {
        id: assignmentId,
        assignmentNumber: 'ASN-AC',
        status: AssignmentStatus.ACCEPTED,
        assayerId: 'assayer-cancel',
        entityVersion: 2,
        isActive: true,
        projectBranch: { id: 'pb-ac', status: ProjectBranchStatus.ASSIGNMENT_CONFIRMED },
      });

      // Assayer tries to cancel their OWN assignment via the generic route
      await expect(
        assignmentController.transition(
          assignmentId,
          { targetStatus: 'CANCELLED', reason: 'I changed my mind' },
          { user: { id: 'assayer-cancel', roles: ['ASSAYER'] } },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids an assayer completing an assignment via the generic transition route', async () => {
      const assignmentId = 'asg-assayer-complete';
      assignmentsDb.set(assignmentId, {
        id: assignmentId,
        assignmentNumber: 'ASN-ACMP',
        status: AssignmentStatus.IN_PROGRESS,
        assayerId: 'assayer-complete',
        entityVersion: 3,
        isActive: true,
        projectBranch: { id: 'pb-acmp', status: ProjectBranchStatus.SCHEDULED },
      });

      // Assayer tries to mark their OWN assignment complete via the generic route
      await expect(
        assignmentController.transition(
          assignmentId,
          { targetStatus: 'COMPLETED' },
          { user: { id: 'assayer-complete', roles: ['ASSAYER'] } },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids an assayer accepting someone else\'s assignment via the generic transition route', async () => {
      const assignmentId = 'asg-not-mine';
      assignmentsDb.set(assignmentId, {
        id: assignmentId,
        assignmentNumber: 'ASN-NM',
        status: AssignmentStatus.PENDING,
        assayerId: 'assayer-real-owner',
        entityVersion: 1,
        isActive: true,
        projectBranch: { id: 'pb-nm', status: ProjectBranchStatus.PLANNING },
      });

      // A different assayer tries to accept it
      await expect(
        assignmentController.transition(
          assignmentId,
          { targetStatus: 'ACCEPTED' },
          { user: { id: 'assayer-intruder', roles: ['ASSAYER'] } },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids an assayer starting work on someone else\'s assignment via the generic transition route', async () => {
      const assignmentId = 'asg-not-mine-start';
      assignmentsDb.set(assignmentId, {
        id: assignmentId,
        assignmentNumber: 'ASN-NMS',
        status: AssignmentStatus.CHECKED_IN,
        assayerId: 'assayer-real-owner-2',
        entityVersion: 2,
        isActive: true,
        projectBranch: { id: 'pb-nms', status: ProjectBranchStatus.SCHEDULED },
      });

      await expect(
        assignmentController.transition(
          assignmentId,
          { targetStatus: 'IN_PROGRESS' },
          { user: { id: 'assayer-intruder-2', roles: ['ASSAYER'] } },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('forbids an ops user reopening via the generic transition route — must use /reopen', async () => {
      const assignmentId = 'asg-ops-reopen';
      assignmentsDb.set(assignmentId, {
        id: assignmentId,
        assignmentNumber: 'ASN-OPS-R',
        status: AssignmentStatus.COMPLETED,
        assayerId: 'assayer-done',
        entityVersion: 5,
        isActive: true,
      });

      // An OPERATIONS user (not assayer) tries COMPLETED → ACCEPTED via transition
      await expect(
        assignmentController.transition(
          assignmentId,
          { targetStatus: 'ACCEPTED' },
          { user: { id: 'ops-user', roles: ['OPERATIONS'] } },
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Operational Integrity Reconciliation Scanner', () => {
    it('scans all 9 operational rules and reports summary without mutating database records', async () => {
      const report = await operationalIntegrityService.scan();

      expect(report).toBeDefined();
      expect(report.scannedRules).toBe(9);
      expect(report.timestamp).toBeDefined();
      expect(report.totalViolations).toBeGreaterThanOrEqual(0);
      expect(report.summary).toBeDefined();
      expect(Array.isArray(report.violations)).toBe(true);
    });
  });

  /**
   * Race M — Assignment Creation Idempotency
   *
   * The desk creates an assignment, the DB commits, but the HTTP response is lost.
   * The retry carries the same `clientRequestId`. The service must:
   * 1. Return the original assignment — no second assignment created
   * 2. Emit no second outbox event
   * 3. Reject a reuse of the same key with a different payload
   */
  describe('Race M — Assignment Creation Idempotency', () => {
    it('returns the original assignment on retry with the same clientRequestId — no duplicate', async () => {
      const branchId = 'pb-create-idemp';
      const assayerId = 'assayer-create-idemp';

      branchesDb.set(branchId, {
        id: branchId,
        branchId: 'branch-phys-1',
        projectId: 'proj-1',
        status: ProjectBranchStatus.PLANNING,
        isActive: true,
        branch: { id: 'branch-phys-1', name: 'Test Branch', latitude: 28.6, longitude: 77.2, state: 'Delhi' },
        project: null,
      });
      assayersDb.set(assayerId, {
        id: assayerId, status: 'ACTIVE', isActive: true,
        homeLatitude: 28.7, homeLongitude: 77.3, displayName: 'Test Assayer',
      });

      // First creation — commits and succeeds
      const firstOutboxCount = publishedOutboxEvents.length;
      const first = await assignmentService.create({
        projectBranchId: branchId,
        assayerId,
        clientRequestId: 'create-key-001',
      }, 'ops-1');

      expect(first).toBeDefined();
      expect(first.status).toBe(AssignmentStatus.PENDING);
      expect(first.assayerId).toBe(assayerId);
      const outboxAfterFirst = publishedOutboxEvents.length;
      expect(outboxAfterFirst).toBeGreaterThan(firstOutboxCount);

      // Simulate the idempotency record being present (the pre-tx check sees it)
      // In the real DB this is written atomically in the same tx; in the mock the
      // manager.query returns [] for the idempotency SELECT, so the record is written
      // to the mock's query layer. We simulate the replay by calling create again
      // and having the mock return the record.
      const originalQuery = mockDataSource.query;
      mockDataSource.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (/assignment_idempotency_records/.test(sql) && params?.[0] === 'create-key-001') {
          return [{
            command: 'CREATE',
            assignment_id: first.id,
            request_hash: (assignmentService as any).computeRequestHash('CREATE', branchId, {
              assayerId,
              projectBranchId: branchId,
              scheduledDate: undefined,
              userId: 'ops-1',
            }),
            response_payload: first,
          }];
        }
        return originalQuery(sql, params);
      });

      // Retry — same clientRequestId, same payload
      const outboxBefore = publishedOutboxEvents.length;
      const second = await assignmentService.create({
        projectBranchId: branchId,
        assayerId,
        clientRequestId: 'create-key-001',
      }, 'ops-1');

      expect(second.id).toBe(first.id);
      expect(second.assignmentNumber).toBe(first.assignmentNumber);
      // No additional outbox event emitted
      expect(publishedOutboxEvents.length).toBe(outboxBefore);

      // Restore
      mockDataSource.query.mockImplementation(originalQuery);
    });

    it('rejects a reuse of the same clientRequestId with a different payload', async () => {
      const branchId = 'pb-create-idemp-2';
      const assayerId = 'assayer-create-idemp-2';

      branchesDb.set(branchId, {
        id: branchId,
        branchId: 'branch-phys-2',
        projectId: 'proj-2',
        status: ProjectBranchStatus.PLANNING,
        isActive: true,
        branch: { id: 'branch-phys-2', name: 'Branch 2', latitude: 28.6, longitude: 77.2, state: 'Delhi' },
        project: null,
      });
      assayersDb.set(assayerId, {
        id: assayerId, status: 'ACTIVE', isActive: true,
        homeLatitude: 28.7, homeLongitude: 77.3, displayName: 'Assayer 2',
      });

      // Simulate an existing idempotency record from a previous create with different payload
      const originalQuery = mockDataSource.query;
      mockDataSource.query.mockImplementation(async (sql: string, params?: any[]) => {
        if (/assignment_idempotency_records/.test(sql) && params?.[0] === 'create-key-conflict') {
          return [{
            command: 'CREATE',
            assignment_id: 'some-other-assignment',
            request_hash: 'a-different-hash',
            response_payload: { id: 'some-other-assignment' },
          }];
        }
        return originalQuery(sql, params);
      });

      await expect(
        assignmentService.create({
          projectBranchId: branchId,
          assayerId,
          clientRequestId: 'create-key-conflict',
        }, 'ops-1'),
      ).rejects.toThrow(ConflictException);

      // Restore
      mockDataSource.query.mockImplementation(originalQuery);
    });
  });
});
