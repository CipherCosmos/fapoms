import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { SchedulingService } from './scheduling.service';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ScheduleStatus, AssignmentStatus } from '@fapoms/shared';

describe('SchedulingService', () => {
  let service: SchedulingService;
  let scheduleRepo: Repository<ScheduleEntity>;
  let assignmentRepo: Repository<AssignmentEntity>;
  let holidayService: HolidayService;

  const mockScheduleRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };

  const mockAssignmentRepo = {
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
        SchedulingService,
        {
          provide: getRepositoryToken(ScheduleEntity),
          useValue: mockScheduleRepo,
        },
        {
          provide: getRepositoryToken(AssignmentEntity),
          useValue: mockAssignmentRepo,
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

    service = module.get<SchedulingService>(SchedulingService);
    scheduleRepo = module.get<Repository<ScheduleEntity>>(getRepositoryToken(ScheduleEntity));
    assignmentRepo = module.get<Repository<AssignmentEntity>>(getRepositoryToken(AssignmentEntity));
    holidayService = module.get<HolidayService>(HolidayService);

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw NotFoundException if assignment is missing', async () => {
      mockAssignmentRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create({ assignmentId: 'asn-missing', scheduledDate: '2026-08-01' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if assignment status is not ACCEPTED', async () => {
      const mockAsn = { id: 'asn-1', status: AssignmentStatus.CREATED };
      mockAssignmentRepo.findOne.mockResolvedValue(mockAsn);

      await expect(
        service.create({ assignmentId: 'asn-1', scheduledDate: '2026-08-01' }, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
