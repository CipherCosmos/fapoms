import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AssignmentService } from './assignment.service';
import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentStatus, ProjectBranchStatus } from '@fapoms/shared';

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

  const mockHolidayService = {
    isHoliday: jest.fn(),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
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
          provide: HolidayService,
          useValue: mockHolidayService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
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

    it('should throw BadRequestException if date is a holiday', async () => {
      const mockBranch = { id: 'pb-1', branch: { state: 'MH' } };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
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
      const mockBranch = { id: 'pb-1', branch: { state: 'MH' } };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
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
      const mockBranch = { id: 'pb-1', projectId: 'p-1', branch: { name: 'Branch 1', state: 'MH' } };
      mockProjectBranchRepo.findOne.mockResolvedValue(mockBranch);
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
      expect(mockProjectBranchRepo.save).toHaveBeenCalled();
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });
  });

  describe('transition', () => {
    it('should throw BadRequestException if transition is invalid', async () => {
      const mockAssignment = {
        id: 'asn-123',
        status: AssignmentStatus.CREATED,
        projectBranch: { id: 'pb-1' },
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
        projectBranch: { id: 'pb-1', status: ProjectBranchStatus.PLANNING },
      };
      mockAssignmentRepo.findOne.mockResolvedValue(mockAssignment);
      mockAssignmentRepo.save.mockImplementation((arg) => Promise.resolve(arg));

      const result = await service.transition('asn-123', AssignmentStatus.CANDIDATE_SELECTED, 'user-1');
      expect(result.status).toBe(AssignmentStatus.CANDIDATE_SELECTED);
    });
  });
});
