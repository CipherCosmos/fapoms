import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { EventCategory, ScheduleStatus, AssignmentStatus, ProjectBranchStatus, SCHEDULE_TRANSITIONS, isValidTransition } from '@fapoms/shared';

export interface CreateScheduleDto {
  assignmentId: string;
  scheduledDate: string;
  remarks?: string;
}

export interface UpdateScheduleDto {
  scheduledDate?: string;
  remarks?: string;
}

@Injectable()
export class SchedulingService {
  constructor(
    @InjectRepository(ScheduleEntity)
    private readonly scheduleRepository: Repository<ScheduleEntity>,
    private readonly assignmentService: AssignmentService,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
    private readonly constraintEvaluator: ConstraintEvaluator,
  ) {}

  async create(dto: CreateScheduleDto, userId: string): Promise<ScheduleEntity> {
    const assignment = await this.assignmentService.findOne(dto.assignmentId);

    if (!assignment) {
      throw new NotFoundException(`Assignment ${dto.assignmentId} not found.`);
    }

    if (![AssignmentStatus.CREATED, AssignmentStatus.ACCEPTED, AssignmentStatus.SCHEDULED].includes(assignment.status as any)) {
      throw new BadRequestException(`Cannot schedule assignment. Current status is ${assignment.status}.`);
    }

    const scheduledDateObj = new Date(dto.scheduledDate);

    // Validate Assayer leaves via ConstraintEvaluator
    if (assignment.assayer) {
      const leavesCheck = this.constraintEvaluator.checkLeaves(assignment.assayer, scheduledDateObj);
      if (!leavesCheck.passed) {
        throw new BadRequestException(leavesCheck.reason);
      }
    }

    // Validate project timeline via ConstraintEvaluator
    if (assignment.project) {
      const timelineCheck = this.constraintEvaluator.checkProjectTimeline(assignment.project, scheduledDateObj);
      if (!timelineCheck.passed) {
        throw new BadRequestException(timelineCheck.reason);
      }
    }

    // Validate Holiday conflict via ConstraintEvaluator
    const stateCode = assignment.projectBranch?.branch?.state ?? 'MH';
    const holidayCheck = await this.constraintEvaluator.checkHoliday(stateCode, scheduledDateObj);
    if (!holidayCheck.passed) {
      throw new BadRequestException(holidayCheck.reason);
    }

    // Validate double booking via ConstraintEvaluator
    const doubleBookedCheck = await this.constraintEvaluator.checkDoubleBooking(assignment.assayerId, scheduledDateObj);
    if (!doubleBookedCheck.passed) {
      throw new ConflictException(doubleBookedCheck.reason);
    }

    const schedule = this.scheduleRepository.create({
      assignmentId: assignment.id,
      projectId: assignment.projectId,
      assayerId: assignment.assayerId,
      scheduledDate: scheduledDateObj,
      status: ScheduleStatus.CONFIRMED, // Confirm directly upon setup
      remarks: dto.remarks ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.scheduleRepository.save(schedule);

    // Transition parent assignment and branch states via the canonical service
    await this.assignmentService.scheduleAudit(assignment.id, userId, dto.scheduledDate);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'SCHEDULE_CONFIRMED',
      entityType: 'SCHEDULE',
      entityId: saved.id,
      userId,
      remarks: `Confirmed schedule for assignment ${assignment.assignmentNumber} on ${dto.scheduledDate}.`,
    });

    return saved;
  }

  async findOne(id: string): Promise<ScheduleEntity> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id, isActive: true },
      relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'project', 'assayer'],
    });
    if (!schedule) {
      throw new NotFoundException(`Schedule ${id} not found.`);
    }
    return schedule;
  }

  async findAll(
    page = 1, limit = 50,
    status?: ScheduleStatus,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<{ schedules: ScheduleEntity[]; total: number }> {
    const where: any = { isActive: true };
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.scheduledDate = {} as any;
      if (dateFrom) where.scheduledDate.gte = new Date(dateFrom);
      if (dateTo) where.scheduledDate.lte = new Date(dateTo);
    }
    const [schedules, total] = await this.scheduleRepository.findAndCount({
      where,
      relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'assayer', 'project'],
      order: { scheduledDate: 'ASC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { schedules, total };
  }

  async transition(id: string, targetStatus: ScheduleStatus, userId: string, remarks?: string, newScheduledDate?: string): Promise<ScheduleEntity> {
    const schedule = await this.findOne(id);
    const prevStatus = schedule.status;

    if (!isValidTransition(SCHEDULE_TRANSITIONS, prevStatus, targetStatus)) {
      throw new BadRequestException(`Invalid Transition: Cannot transition schedule from ${prevStatus} to ${targetStatus}.`);
    }

    schedule.status = targetStatus;
    if (remarks) schedule.remarks = remarks;
    if (newScheduledDate) {
      schedule.scheduledDate = new Date(newScheduledDate);
      if (schedule.assignmentId) {
        await this.assignmentService.scheduleAudit(schedule.assignmentId, userId, newScheduledDate);
      }
    }
    schedule.updatedBy = userId;

    const saved = await this.scheduleRepository.save(schedule);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: `SCHEDULE_${targetStatus}`,
      entityType: 'SCHEDULE',
      entityId: saved.id,
      previousState: prevStatus,
      newState: targetStatus,
      userId,
      remarks: remarks ?? `Transitioned schedule to ${targetStatus}`,
    });

    return saved;
  }

  async getAssayerWorkloadInRange(assayerId: string, from: Date, to: Date): Promise<{ count: number; schedules: any[] }> {
    const schedules = await this.scheduleRepository.find({
      where: {
        assayerId,
        isActive: true,
        scheduledDate: { gte: from, lte: to } as any,
      },
      relations: ['assignment', 'project'],
      order: { scheduledDate: 'ASC' },
    });
    return {
      count: schedules.length,
      schedules: schedules.map(s => ({
        id: s.id,
        scheduledDate: s.scheduledDate,
        status: s.status,
        projectName: s.project?.name,
        assignmentNumber: s.assignment?.assignmentNumber,
      })),
    };
  }

  async getTimeline(scheduleId: string): Promise<any[]> {
    const schedule = await this.findOne(scheduleId);
    const { events } = await this.auditService.getEntityHistory('SCHEDULE', schedule.id, 100);
    const timelineEvents: any[] = [];
    for (const e of events) {
      timelineEvents.push({
        id: e.id,
        type: 'SYSTEM_EVENT',
        title: e.eventType,
        description: e.remarks,
        timestamp: e.occurredAt,
        user: e.userDisplayName || e.userId,
      });
    }
    return timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
}
