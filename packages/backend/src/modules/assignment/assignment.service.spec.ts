import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentStatus, ProjectBranchStatus, EventCategory } from '@fapoms/shared';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssayerService } from '../assayer/assayer.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { AssessmentEntity } from '../project/assessment.entity';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';

describe('AssignmentService', () => {
  let service: AssignmentService;
  let assignmentRepo: Repository<AssignmentEntity>;
  let holidayService: HolidayService;
  let auditService: AuditService;

  const mockAssignmentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
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

  const mockDataSource = {
    transaction: jest.fn((cb) => cb({
      save: jest.fn((arg) => Promise.resolve(arg)),
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn(),
      }),
    })),
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
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: ProjectQueryService, useValue: mockProjectQueryService },
        { provide: ProjectService, useValue: mockProjectService },
        { provide: AssayerService, useValue: mockAssayerService },
        { provide: HolidayService, useValue: mockHolidayService },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: PushNotificationService, useValue: mockPushNotificationService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockDomainEventPublisher },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ConstraintEvaluator, useValue: mockConstraintEvaluator },
        { provide: RoutingService, useValue: { calculateRoute: jest.fn().mockResolvedValue({ distanceKm: 5, durationMinutes: 10 }) } },
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
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.NEGOTIATION },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(assignment);
      mockAssignmentRepo.save.mockImplementation((a) => Promise.resolve(a));

      const result = await service.acceptOffer('asn-1', 'user-1', 2000);
      expect(result.status).toBe(AssignmentStatus.ACCEPTED);
      expect(result.agreedFee).toBe(2000);
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
});
