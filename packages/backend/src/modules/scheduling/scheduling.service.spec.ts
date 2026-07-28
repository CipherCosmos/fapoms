import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SchedulingService } from './scheduling.service';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { ScheduleStatus, AssignmentStatus } from '@fapoms/shared';

describe('SchedulingService', () => {
  let service: SchedulingService;
  let scheduleRepo: Repository<ScheduleEntity>;
  let assignmentService: AssignmentService;
  let holidayService: HolidayService;

  const mockScheduleRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };

  const mockAssignmentService = {
    findOne: jest.fn(),
    scheduleAudit: jest.fn().mockResolvedValue(undefined),
  };

  const mockHolidayService = {
    isHoliday: jest.fn(),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
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
        SchedulingService,
        {
          provide: getRepositoryToken(ScheduleEntity),
          useValue: mockScheduleRepo,
        },
        {
          provide: AssignmentService,
          useValue: mockAssignmentService,
        },
        {
          provide: HolidayService,
          useValue: mockHolidayService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: ConstraintEvaluator,
          useValue: mockConstraintEvaluator,
        },
      ],
    }).compile();

    service = module.get<SchedulingService>(SchedulingService);
    scheduleRepo = module.get<Repository<ScheduleEntity>>(getRepositoryToken(ScheduleEntity));
    assignmentService = module.get<AssignmentService>(AssignmentService);
    holidayService = module.get<HolidayService>(HolidayService);

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw NotFoundException if assignment is missing', async () => {
      mockAssignmentService.findOne.mockResolvedValue(null);

      await expect(
        service.create({ assignmentId: 'asn-missing', scheduledDate: '2026-08-01' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if assignment status is not schedulable (e.g. CANCELLED)', async () => {
      const mockAsn = { id: 'asn-1', status: AssignmentStatus.CANCELLED };
      mockAssignmentService.findOne.mockResolvedValue(mockAsn);

      await expect(
        service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-01' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if assayer is on leave', async () => {
      const mockAsn = {
        id: 'asn-1',
        status: AssignmentStatus.ACCEPTED,
        assayer: {
          leaves: [{ startDate: '2026-08-01', endDate: '2026-08-05' }],
        },
      };
      mockAssignmentService.findOne.mockResolvedValue(mockAsn);
      mockConstraintEvaluator.checkLeaves.mockReturnValueOnce({ passed: false, reason: 'Assayer is on leave' });

      await expect(
        service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-03' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if scheduled date is outside project timeline', async () => {
      const mockAsn = {
        id: 'asn-1',
        status: AssignmentStatus.ACCEPTED,
        assayer: { leaves: [] },
        project: {
          startDate: '2026-08-05',
          endDate: '2026-08-10',
        },
      };
      mockAssignmentService.findOne.mockResolvedValue(mockAsn);
      mockConstraintEvaluator.checkProjectTimeline.mockReturnValueOnce({ passed: false, reason: 'Outside project timeline' });

      await expect(
        service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-03' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

