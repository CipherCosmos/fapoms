import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
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
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateScheduleDto, userId: string): Promise<ScheduleEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id: dto.assignmentId, isActive: true },
      relations: ['projectBranch', 'projectBranch.branch', 'project', 'assayer'],
    });

    if (!assignment) {
      throw new NotFoundException(`Assignment ${dto.assignmentId} not found.`);
    }

    if (assignment.status !== AssignmentStatus.ACCEPTED) {
      throw new BadRequestException(`Cannot schedule assignment. Current status must be ACCEPTED (got ${assignment.status}).`);
    }

    const scheduledDateObj = new Date(dto.scheduledDate);

    // Validate Assayer leaves
    if (assignment.assayer && assignment.assayer.leaves && assignment.assayer.leaves.length > 0) {
      const targetTime = scheduledDateObj.getTime();
      const onLeave = assignment.assayer.leaves.some((leave) => {
        const start = new Date(leave.startDate).getTime();
        const end = new Date(leave.endDate).getTime();
        return targetTime >= start && targetTime <= end;
      });
      if (onLeave) {
        throw new BadRequestException(`Assayer Unavailable: Assayer is on leave on ${dto.scheduledDate}.`);
      }
    }

    // Validate project timeline
    if (assignment.project) {
      const scheduledTime = scheduledDateObj.getTime();
      if (assignment.project.startDate) {
        const projectStart = new Date(assignment.project.startDate).getTime();
        if (scheduledTime < projectStart) {
          throw new BadRequestException(`Timeline Conflict: Scheduled date ${dto.scheduledDate} is before project start date ${assignment.project.startDate}.`);
        }
      }
      if (assignment.project.endDate) {
        const projectEnd = new Date(assignment.project.endDate).getTime();
        if (scheduledTime > projectEnd) {
          throw new BadRequestException(`Timeline Conflict: Scheduled date ${dto.scheduledDate} is after project end date ${assignment.project.endDate}.`);
        }
      }
    }

    // Validate Holiday conflict
    const isHoliday = await this.holidayService.isHoliday(scheduledDateObj, assignment.projectBranch.branch.state);
    if (isHoliday) {
      throw new BadRequestException(`Holiday Conflict: ${dto.scheduledDate} is a holiday in ${assignment.projectBranch.branch.state}.`);
    }

    // Validate double booking
    const doubleBooked = await this.scheduleRepository.findOne({
      where: {
        assayerId: assignment.assayerId,
        scheduledDate: scheduledDateObj,
        status: In([ScheduleStatus.CONFIRMED]),
        isActive: true,
      },
    });

    if (doubleBooked) {
      throw new ConflictException(`Assayer double booking: already scheduled on ${dto.scheduledDate}.`);
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

    // Transition parent assignment and branch states
    assignment.status = AssignmentStatus.SCHEDULED;
    assignment.scheduledDate = scheduledDateObj;
    assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
    assignment.projectBranch.scheduledDate = scheduledDateObj;

    await this.assignmentRepository.save(assignment);

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
      relations: ['assignment', 'project', 'assayer'],
    });
    if (!schedule) {
      throw new NotFoundException(`Schedule ${id} not found.`);
    }
    return schedule;
  }

  async findAll(page = 1, limit = 50): Promise<{ schedules: ScheduleEntity[]; total: number }> {
    const [schedules, total] = await this.scheduleRepository.findAndCount({
      where: { isActive: true },
      relations: ['assignment', 'assayer', 'project'],
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
        const assignment = await this.assignmentRepository.findOne({ where: { id: schedule.assignmentId } });
        if (assignment) {
          assignment.scheduledDate = new Date(newScheduledDate);
          await this.assignmentRepository.save(assignment);
        }
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
