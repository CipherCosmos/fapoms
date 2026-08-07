import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
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
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { AssessmentEntity } from '../project/assessment.entity';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';
import { ValidationService } from '../validation/validation.service';
import { FeePolicyService } from '../pricing/fee-policy.service';

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
    getActiveCommercialProfile: jest.fn().mockResolvedValue({ baseFee: 1500 }),
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
    recordEvent: jest.fn(),
  };

  const mockDomainEventPublisher = {
    publish: jest.fn(),
  };

  const mockUserRepoViaDataSource = {
    findOne: jest.fn(),
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
    getRepository: jest.fn().mockReturnValue(mockUserRepoViaDataSource),
  };

  const mockConstraintEvaluator = {
    checkDoubleBooking: jest.fn().mockResolvedValue({ passed: true }),
    checkLeaves: jest.fn().mockReturnValue({ passed: true }),
    checkProjectTimeline: jest.fn().mockReturnValue({ passed: true }),
    checkHoliday: jest.fn().mockResolvedValue({ passed: true }),
    checkSkillsAndCertifications: jest.fn().mockReturnValue({ passed: true }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentService,
        {
          provide: FeePolicyService,
          useValue: {
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
          },
        },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: ProjectService, useValue: mockProjectService },
        { provide: AssayerService, useValue: mockAssayerService },
        { provide: HolidayService, useValue: mockHolidayService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: NotificationDispatchService, useValue: mockNotificationDispatch },
        { provide: PushNotificationService, useValue: mockPushNotificationService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ConstraintEvaluator, useValue: mockConstraintEvaluator },
        { provide: RoutingService, useValue: { calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 5, durationMinutes: 10 }) } },
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
      mockUserRepoViaDataSource.findOne.mockResolvedValue({ id: 'ops-1', roles: [{ name: 'OPERATIONS_MANAGER' }] });
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

    it('records how far from the branch a distant check-in was, rather than hiding it', async () => {
      const assignment = acceptedAssignment();
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      // ~1,700 km away — the old New Delhi fallback would have looked exactly like this.
      await service.recordCheckIn('asn-1', 28.6315, 77.2167, undefined, 'assayer-1');

      expect(assignment.checkInDistanceMeters).toBeGreaterThan(1_000_000);
    });

    it('leaves distance null when the branch itself has no coordinates', async () => {
      const assignment = acceptedAssignment({ projectBranch: { branch: { latitude: null, longitude: null } } });
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a: any) => Promise.resolve(a));

      await service.recordCheckIn('asn-1', 12.97, 77.59, undefined, 'assayer-1');

      expect(assignment.checkInDistanceMeters).toBeNull();
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
});
