import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { NotificationService } from '../notifications/notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentStatus, ProjectBranchStatus } from '@fapoms/shared';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';

describe('AssignmentService', () => {
  let service: AssignmentService;
  let assignmentRepo: Repository<AssignmentEntity>;
  let projectBranchRepo: Repository<ProjectBranchEntity>;
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

  const mockHolidayService = {
    isHoliday: jest.fn(),
  };

  const mockNotificationService = {
    create: jest.fn().mockImplementation(async (dto) => ({ id: 'notif-123', ...dto })),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  const mockDataSource = {
    transaction: jest.fn((cb) => cb({
      save: jest.fn((arg) => Promise.resolve(arg)),
    })),
  };

  const mockWorkflowEngine = {
    registerWorkflow: jest.fn(),
    executeTransition: jest.fn().mockImplementation(async (key, id, from, to, ctx) => {
      // Simulate valid transition paths
      const validPaths: Record<string, string[]> = {
        CREATED: ['ACCEPTED', 'REJECTED', 'CANCELLED', 'CANDIDATE_SELECTED'],
        ACCEPTED: ['SCHEDULED'],
        SCHEDULED: ['AUDIT_COMPLETED'],
        AUDIT_COMPLETED: ['CLOSED'],
      };
      const allowed = validPaths[from] || [];
      if (!allowed.includes(to)) {
        throw new BadRequestException(`Invalid transition from '${from}' to '${to}'`);
      }

      if (to === 'ACCEPTED') {
        ctx.payload.assignment.agreedFee = ctx.payload.fee ?? ctx.payload.assignment.proposedFee;
        ctx.payload.assignment.projectBranch.status = 'ASSIGNMENT_CONFIRMED';
      }
      if (to === 'REJECTED') {
        ctx.payload.assignment.rejectReason = ctx.payload.reason ?? 'Rejected';
        ctx.payload.assignment.projectBranch.status = 'CANDIDATE_SEARCH';
      }
      if (to === 'CANCELLED') {
        ctx.payload.assignment.cancelReason = ctx.payload.reason ?? 'Cancelled';
        ctx.payload.assignment.projectBranch.status = 'CANDIDATE_SEARCH';
      }
      if (to === 'SCHEDULED') {
        if (ctx.payload.scheduledDate) {
          ctx.payload.assignment.scheduledDate = new Date(ctx.payload.scheduledDate);
          ctx.payload.assignment.projectBranch.scheduledDate = new Date(ctx.payload.scheduledDate);
        }
        ctx.payload.assignment.projectBranch.status = 'SCHEDULED';
      }
      if (to === 'AUDIT_COMPLETED') {
        ctx.payload.assignment.completionDate = new Date();
        ctx.payload.assignment.projectBranch.status = 'AUDIT_COMPLETED';
      }
      if (to === 'CLOSED') {
        ctx.payload.assignment.projectBranch.status = 'CLOSED';
      }
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AssignmentService,
        {
          provide: getRepositoryToken(AssignmentEntity),
          useValue: mockAssignmentRepo,
        },
        {
          provide: getRepositoryToken(ProjectBranchEntity),
          useValue: mockProjectBranchRepo,
        },
        {
          provide: getRepositoryToken(AssayerEntity),
          useValue: mockAssayerRepo,
        },
        {
          provide: HolidayService,
          useValue: mockHolidayService,
        },
        {
          provide: NotificationService,
          useValue: mockNotificationService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: WorkflowEngine,
          useValue: mockWorkflowEngine,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<AssignmentService>(AssignmentService);
    assignmentRepo = module.get<Repository<AssignmentEntity>>(getRepositoryToken(AssignmentEntity));
    projectBranchRepo = module.get<Repository<ProjectBranchEntity>>(getRepositoryToken(ProjectBranchEntity));
    holidayService = module.get<HolidayService>(HolidayService);
    auditService = module.get<AuditService>(AuditService);

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw NotFoundException if project branch does not exist', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
          },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if assayer does not exist', async () => {
      const mockBranch = { id: 'pb-1', branch: { state: 'MH' }, project: {} };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
          },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if assayer lacks required skills', async () => {
      const mockBranch = {
        id: 'pb-1',
        branch: { state: 'MH' },
        project: { requiredSkills: ['Expert Appraiser'] },
      };
      const mockAssayer = { id: 'as-1', skills: ['Junior Valuer'] };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);

      await expect(
        service.create(
          {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if assayer lacks required certifications', async () => {
      const mockBranch = {
        id: 'pb-1',
        branch: { state: 'MH' },
        project: { requiredSkills: [], requiredCertifications: ['Gold Appraiser Cert'] },
      };
      const mockAssayer = {
        id: 'as-1',
        skills: [],
        certifications: [{ name: 'Basic Valuer Cert', expiryDate: '2027-01-01' }],
      };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);

      await expect(
        service.create(
          {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if date is a holiday', async () => {
      const mockBranch = { id: 'pb-1', branch: { state: 'MH' }, project: {} };
      const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
      mockHolidayService.isHoliday.mockResolvedValue(true);

      await expect(
        service.create(
          {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
          },
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException if assayer is double-booked', async () => {
      const mockBranch = { id: 'pb-1', branch: { state: 'MH' }, project: {} };
      const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
      mockHolidayService.isHoliday.mockResolvedValue(false);
      mockAssignmentRepo.findOne.mockResolvedValue({ id: 'existing-asn' });

      await expect(
        service.create(
          {
            projectBranchId: 'pb-1',
            assayerId: 'as-1',
            proposedFee: 500,
            scheduledDate: '2026-08-01',
          },
          'user-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should successfully create an assignment in CREATED status', async () => {
      const mockBranch = { id: 'pb-1', projectId: 'p-1', branch: { name: 'Branch 1', state: 'MH' }, project: {} };
      const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
      mockHolidayService.isHoliday.mockResolvedValue(false);
      mockAssignmentRepo.findOne.mockResolvedValue(null);

      const mockCreatedAssignment = {
        id: 'asn-123',
        assignmentNumber: 'ASN-2026-1234',
        status: AssignmentStatus.CREATED,
      };
      mockAssignmentRepo.create.mockReturnValue(mockCreatedAssignment);
      mockAssignmentRepo.save.mockResolvedValue(mockCreatedAssignment);

      const result = await service.create(
        {
          projectBranchId: 'pb-1',
          assayerId: 'as-1',
          proposedFee: 500,
          scheduledDate: '2026-08-01',
        },
        'user-1',
      );

      expect(result.status).toBe(AssignmentStatus.CREATED);
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });
  });

  describe('transition', () => {
    it('should throw BadRequestException if transition is invalid', async () => {
      const mockAssignment = {
        id: 'asn-123',
        status: AssignmentStatus.CREATED,
        projectBranch: { id: 'pb-1', branch: { state: 'MH' } },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);

      await expect(
        service.transition('asn-123', AssignmentStatus.SCHEDULED, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should transition from CREATED to CANDIDATE_SELECTED', async () => {
      const mockAssignment = {
        id: 'asn-123',
        status: AssignmentStatus.CREATED,
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.PLANNING, branch: { state: 'MH' } },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
      mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));

      const result = await service.transition('asn-123', AssignmentStatus.CANDIDATE_SELECTED, 'user-1');
      expect(result.status).toBe(AssignmentStatus.CANDIDATE_SELECTED);
    });
  });

  describe('update', () => {
    it('should throw BadRequestException if assignment is locked (ACCEPTED status)', async () => {
      const mockAssignment = {
        id: 'asn-123',
        status: AssignmentStatus.ACCEPTED,
        projectBranch: { id: 'pb-1' },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);

      await expect(
        service.update('asn-123', { proposedFee: 600 }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('SLA and Notifications validation', () => {
    it('should calculate SLA due date based on client configuration in create', async () => {
      const mockBranch = {
        id: 'pb-1',
        projectId: 'p-1',
        branch: { name: 'Branch 1', state: 'MH' },
        project: {
          client: {
            configuration: {
              maxResponseTimeHours: 48,
            },
          },
        },
      };
      const mockAssayer = { id: 'as-1', skills: [], certifications: [] };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
      mockAssayerRepo.findOne.mockResolvedValue(mockAssayer);
      mockHolidayService.isHoliday.mockResolvedValue(false);
      mockAssignmentRepo.findOne.mockResolvedValue(null);

      const mockCreatedAssignment = {
        id: 'asn-123',
        assignmentNumber: 'ASN-2026-1234',
        status: AssignmentStatus.CREATED,
      };
      mockAssignmentRepo.create.mockImplementation((arg) => ({ ...mockCreatedAssignment, ...arg }));
      mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));

      const result = await service.create(
        {
          projectBranchId: 'pb-1',
          assayerId: 'as-1',
          proposedFee: 500,
          scheduledDate: '2026-08-01',
        },
        'user-1',
      );

      expect(result.slaDueDate).toBeDefined();
      const expectedTime = new Date().getTime() + 48 * 60 * 60 * 1000;
      expect(Math.abs(result.slaDueDate!.getTime() - expectedTime)).toBeLessThan(5000);
    });

    it('should trigger notification when transitioning to ACCEPTED status', async () => {
      const mockAssignment = {
        id: 'asn-123',
        assignmentNumber: 'ASN-2026-1234',
        status: AssignmentStatus.CREATED,
        createdBy: 'creator-user',
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.PLANNING, branch: { state: 'MH' } },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
      mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));

      await service.transition('asn-123', AssignmentStatus.ACCEPTED, 'user-1');

      expect(mockNotificationService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'creator-user',
          title: 'Assignment Accepted',
        }),
        'user-1',
      );
    });
  });
});
