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
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
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
    // The schedule→assignment completion cascade; see the "completing a schedule" block below.
    completeAssignment: jest.fn().mockResolvedValue(undefined),
  };

  const mockHolidayService = {
    isHoliday: jest.fn(),
  };

  const mockAuditService = {
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  const mockConstraintEvaluator = {
    checkDoubleBooking: jest.fn().mockResolvedValue({ passed: true }),
    checkLeaves: jest.fn().mockReturnValue({ passed: true }),
    checkProjectTimeline: jest.fn().mockReturnValue({ passed: true }),
    checkHoliday: jest.fn().mockResolvedValue({ passed: true }),
    checkDateAvailability: jest.fn().mockResolvedValue({ passed: true }),
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
        {
          provide: DomainEventPublisher,
          useValue: { publish: jest.fn() },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emitSafe: jest.fn() },
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

  /**
   * Completing a schedule and completing its assignment are one action, not two.
   *
   * The cascade failure used to be swallowed with a `console.warn` while the schedule was saved as
   * COMPLETED anyway. Marking a visit complete before the assayer checked in therefore produced a
   * schedule that said COMPLETED, an assignment still on ACCEPTED, a branch still on
   * ASSIGNMENT_CONFIRMED, no validation case and no billing entry — an audit that read as finished
   * everywhere and could never be finished, because the reschedule guard refuses anything whose
   * schedule is already COMPLETED.
   */
  describe('completing a schedule', () => {
    const scheduleFor = (assignment: any) => ({
      id: 'sch-1',
      status: ScheduleStatus.CONFIRMED,
      assignmentId: assignment.id,
      assignment,
    });

    it('refuses when the assignment cannot complete, and leaves both untouched', async () => {
      // ACCEPTED, never checked in — COMPLETED is not reachable from here.
      const assignment = {
        id: 'asn-1',
        status: AssignmentStatus.ACCEPTED,
        projectBranch: { status: 'ASSIGNMENT_CONFIRMED' },
      };
      const schedule = scheduleFor(assignment);
      mockScheduleRepo.findOne.mockResolvedValue(schedule);
      mockAssignmentService.findOne.mockResolvedValue(assignment);
      mockAssignmentService.completeAssignment = jest
        .fn()
        .mockRejectedValue(new BadRequestException("Invalid transition path from 'ACCEPTED' to 'COMPLETED'"));

      await expect(
        service.transition('sch-1', ScheduleStatus.COMPLETED, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      // Nothing persisted: the schedule must not be left claiming a completion that never happened.
      expect(mockScheduleRepo.save).not.toHaveBeenCalled();
    });

    it('stays idempotent when the assignment already completed via the document path', async () => {
      const assignment = {
        id: 'asn-1',
        status: AssignmentStatus.COMPLETED,
        projectBranch: { status: 'AUDIT_COMPLETED' },
      };
      // The reschedule guard runs first and refuses anything already completed — which is the
      // correct answer here too, and proves the two are never allowed to drift apart.
      mockScheduleRepo.findOne.mockResolvedValue(scheduleFor(assignment));
      mockAssignmentService.findOne.mockResolvedValue(assignment);
      mockAssignmentService.completeAssignment = jest.fn();

      await expect(
        service.transition('sch-1', ScheduleStatus.COMPLETED, 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockAssignmentService.completeAssignment).not.toHaveBeenCalled();
    });
  });
});

