import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
import { DEFAULT_WEEKLY_CAPACITY } from '../assignment/assignment-workload';
import { branchScopeWhere } from '../../infrastructure/scope/apply-scope';
import { GlobalScope, assertClientAllowed } from '../../infrastructure/scope/global-scope';
import { ScheduleEntity } from './schedule.entity';
import { AssignmentService } from '../assignment/assignment.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { EventCategory, ScheduleStatus, ProjectBranchStatus, AssignmentStatus, SCHEDULE_TRANSITIONS, isValidTransition, businessDateKey } from '@fapoms/shared';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

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
    private readonly eventPublisher: DomainEventPublisher,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  async create(dto: CreateScheduleDto, userId: string): Promise<ScheduleEntity> {
    const assignment = await this.assignmentService.findOne(dto.assignmentId);

    if (!assignment) {
      throw new NotFoundException(`Assignment ${dto.assignmentId} not found.`);
    }

    if (assignment.projectBranch?.status !== ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
      throw new BadRequestException(`Cannot schedule assignment: branch status must be ASSIGNMENT_CONFIRMED, got ${assignment.projectBranch?.status}.`);
    }

    const scheduledDateObj = new Date(dto.scheduledDate);

    // One gate, shared with rescheduling and with AssignmentService — see
    // ConstraintEvaluator.checkDateAvailability. The three checks were previously spelled out
    // here and nowhere else, which is why the reschedule path had none of them.
    const availability = await this.constraintEvaluator.checkDateAvailability({
      assayer: assignment.assayer ?? null,
      assayerId: assignment.assayerId,
      project: assignment.project ?? null,
      branchState: assignment.projectBranch?.branch?.state ?? null,
      clientId: assignment.project?.clientId ?? null,
      scheduledDate: scheduledDateObj,
      excludeAssignmentId: assignment.id,
    });
    if (!availability.passed) {
      throw new BadRequestException(availability.reason);
    }

    const existingSchedule = await this.scheduleRepository.findOne({
      where: { assignmentId: assignment.id, isActive: true },
    }).catch(() => null);

    if (existingSchedule) {
      existingSchedule.scheduledDate = scheduledDateObj;
      if (dto.remarks) existingSchedule.remarks = dto.remarks;
      existingSchedule.updatedBy = userId;
      // Date the assignment FIRST and let a refusal propagate: saving the calendar row and then
      // swallowing a scheduleAudit failure left the calendar and the job on two different dates.
      const dated = await this.assignmentService.scheduleAudit(assignment.id, userId, dto.scheduledDate);
      const updated = await this.scheduleRepository.save(existingSchedule);
      this.emitDispatchNotification(assignment, updated.id, dto.scheduledDate, userId, dated?.entityVersion);
      return updated;
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
    const dated = await this.assignmentService.scheduleAudit(assignment.id, userId, dto.scheduledDate);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'SCHEDULE_CONFIRMED',
      entityType: 'SCHEDULE',
      entityId: saved.id,
      userId,
      remarks: `Confirmed schedule for assignment ${assignment.assignmentNumber} on ${dto.scheduledDate}.`,
    });

    this.emitDispatchNotification(assignment, saved.id, dto.scheduledDate, userId, dated?.entityVersion);

    try {
      this.eventPublisher.publish('schedule:created', {
        eventType: 'schedule:created',
        scheduleId: saved.id,
        assignmentId: saved.assignmentId,
        assayerId: saved.assayerId,
        organizationId: (assignment as any).projectBranch?.project?.organizationId,
        scheduledDate: saved.scheduledDate,
        status: saved.status,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish schedule:created event:', err);
    }

    return saved;
  }

  /**
   * Tell the assayer their audit is on the calendar. Fire-and-forget by design: the schedule is
   * already saved, and Bull gives delivery its own durability — but a dispatch nobody hears about
   * is not a dispatch, so this fires on every create/re-date. Dedupe includes the date AND the
   * assignment version the dating committed: the date alone swallowed a move back to an earlier
   * day (A → B → A → B: the second B was "already sent"), while the version is new on every real
   * write and the same on a replay of one. Falls back to the date alone when no version is known.
   */
  private emitDispatchNotification(
    assignment: any,
    scheduleId: string,
    scheduledDate: string,
    userId: string,
    assignmentVersion?: number | null,
  ): void {
    this.notificationDispatch.emitSafe({
      type: 'SCHEDULE_DISPATCHED',
      entityType: 'SCHEDULE',
      entityId: scheduleId,
      actorUserId: userId,
      assayerId: assignment.assayerId,
      dedupeKey: `SCHEDULE_DISPATCHED:${scheduleId}:${scheduledDate}${assignmentVersion ? `:${assignmentVersion}` : ''}`,
      payload: {
        assignmentId: assignment.id,
        assignmentNumber: assignment.assignmentNumber,
        branchName: assignment.projectBranch?.branch?.name ?? 'the branch',
        scheduledDate,
      },
    });
  }

  async findOne(id: string, scope?: Partial<GlobalScope>): Promise<ScheduleEntity> {
    const schedule = await this.scheduleRepository.findOne({
      where: { id, isActive: true },
      relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'project', 'assayer'],
    });
    if (!schedule) {
      throw new NotFoundException(`Schedule ${id} not found.`);
    }
    // A client ceiling only narrows a LIST — `findAll`'s `branchScopeWhere` does that already.
    // This is the by-id counterpart: the id came straight off the URL, not a filtered query, so
    // without this a CLIENT_USER could fetch any other client's schedule (and everything it
    // joins in — the assignment, the branch, the assayer's own contact details) by id alone.
    assertClientAllowed(schedule.project?.clientId, scope);
    return schedule;
  }

  async findAll(
    page = 1, limit = 50,
    status?: ScheduleStatus,
    dateFrom?: string,
    dateTo?: string,
    scope?: Partial<GlobalScope>,
  ): Promise<{ schedules: ScheduleEntity[]; total: number }> {
    const where: any = { isActive: true };
    if (status) where.status = status;
    // Real TypeORM operators. This used to build a plain `{gte, lte}` object, which TypeORM
    // serialises as a literal JSON string into the SQL — `invalid input syntax for type date` —
    // and it lay dormant because nothing sent dateFrom/dateTo until the calendar was month-scoped.
    // Date-only strings on purpose: the column is `date`, and a Date-with-time never matches it.
    if (dateFrom && dateTo) {
      where.scheduledDate = Between(dateFrom, dateTo);
    } else if (dateFrom) {
      where.scheduledDate = MoreThanOrEqual(dateFrom);
    } else if (dateTo) {
      where.scheduledDate = LessThanOrEqual(dateTo);
    }
    // schedule → assignment → project_branch → branch is where region/state/zone live. The
    // relation is already loaded below, so scoping costs nothing extra here.
    const branchWhere = branchScopeWhere(scope);
    if (branchWhere) where.assignment = { projectBranch: { branch: branchWhere } };
    if (scope?.projectId) where.projectId = scope.projectId;

    const [schedules, total] = await this.scheduleRepository.findAndCount({
      where,
      relations: ['assignment', 'assignment.projectBranch', 'assignment.projectBranch.branch', 'assayer', 'project'],
      order: { scheduledDate: 'ASC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    // Schedules are returned exactly as stored.
    //
    // This used to rewrite the status to COMPLETED in the response whenever the parent
    // assignment or branch had completed, without persisting anything — a read-time patch over
    // a write-time bug. That bug is fixed at its source: AssignmentService now brings the
    // schedule to COMPLETED inside the same transaction that completes the assignment, so the
    // two cannot drift apart in the first place (it previously ran as raw SQL outside the
    // transaction, with failures swallowed by a console.error).
    //
    // Reporting a status the database does not hold is worse than showing a stale one: it
    // makes a genuine divergence invisible precisely when someone needs to see it, and the
    // figure on screen stops matching the figure in any export or query.
    return { schedules, total };
  }

  async transition(id: string, targetStatus: ScheduleStatus, userId: string, remarks?: string, newScheduledDate?: string): Promise<ScheduleEntity> {
    const schedule = await this.findOne(id);
    const prevStatus = schedule.status;

    if (schedule.assignment?.projectBranch) {
      const pbStatus = schedule.assignment.projectBranch.status;
      if (['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes(pbStatus) || schedule.assignment.status === 'COMPLETED' || prevStatus === ScheduleStatus.COMPLETED) {
        throw new BadRequestException('Cannot reschedule an audit that has already been completed or is under validation review.');
      }
    }

    if (!isValidTransition(SCHEDULE_TRANSITIONS, prevStatus, targetStatus)) {
      throw new BadRequestException(`Invalid Transition: Cannot transition schedule from ${prevStatus} to ${targetStatus}.`);
    }

    schedule.status = targetStatus;
    if (remarks) schedule.remarks = remarks;
    // Captured before the overwrite — the reschedule notification tells the assayer what moved.
    const previousDate = schedule.scheduledDate;
    // The assignment version the re-dating committed — the reschedule notice's occurrence.
    let redatedVersion: number | null = null;
    if (newScheduledDate) {
      schedule.scheduledDate = new Date(newScheduledDate);
      if (schedule.assignmentId) {
        const dated = await this.assignmentService.scheduleAudit(schedule.assignmentId, userId, newScheduledDate);
        redatedVersion = dated?.entityVersion ?? null;
      }
    }

    // Record completion timestamp for audit duration calculation (Audit Workflow only)
    if (targetStatus === ScheduleStatus.COMPLETED) {
      schedule.completedAt = new Date();

      /**
       * Cascade: complete the parent assignment (sets completionDate, transitions branch to
       * AUDIT_COMPLETED, opens the validation case and books the payable).
       *
       * The cascade failure used to be swallowed with a `console.warn`, and the schedule was saved
       * as COMPLETED regardless. Marking a visit complete before the assayer had checked in
       * therefore left the schedule COMPLETED, the assignment stuck on ACCEPTED and the branch on
       * ASSIGNMENT_CONFIRMED — an audit that reads as finished on every screen, never reaches
       * validation, and is never billed. It could not even be repaired: the guard at the top of
       * this method refuses to reschedule anything whose schedule is already COMPLETED, so the
       * work was stranded permanently.
       *
       * The two now succeed or fail together. An assignment that is already COMPLETED (the
       * document-upload path got there first) is the one benign case and stays idempotent.
       */
      if (schedule.assignmentId) {
        const assignment = schedule.assignment ?? (await this.assignmentService.findOne(schedule.assignmentId));

        if (assignment?.status !== AssignmentStatus.COMPLETED) {
          try {
            /**
             * No reason is supplied, deliberately.
             *
             * This used to pass `Completed via schedule dispatch`, which satisfied
             * `completeAssignment`'s requirement that somebody account for an incomplete
             * attendance record with a sentence no human wrote. A control a machine can
             * discharge on your behalf is not a control. Dispatch now closes the visit only
             * when the attendance record already stands on its own.
             */
            await this.assignmentService.completeAssignment(schedule.assignmentId, userId);
          } catch {
            /**
             * Refuse the whole transition rather than persist half of it. The message names the
             * missing step, because the usual cause is a visit marked complete before anyone
             * arrived on site — or, now, before anyone recorded leaving it.
             */
            throw new BadRequestException(
              `This visit cannot be completed yet: the assignment is still ${assignment?.status ?? 'unavailable'}. ` +
                'The assayer needs a check-in and a check-out on site first — time on site is the attendance ' +
                'evidence, and completing the schedule on its own would leave the audit unbilled and unable to ' +
                'reach validation. If the visit really happened and a stamp is missing, close it from the ' +
                'assignment itself, where somebody states why.',
            );
          }
        }
      }
    }

    schedule.updatedBy = userId;

    const saved = await this.scheduleRepository.save(schedule);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: `SCHEDULE_${targetStatus}`,
      entityType: 'SCHEDULE',
      entityId: saved.id,
      previousState: prevStatus,
      newState: targetStatus,
      userId,
      remarks: remarks ?? `Transitioned schedule to ${targetStatus}`,
    });

    // The assayer must hear that their audit moved — the reschedule was previously silent, so a
    // field worker could drive to a branch on the original date.
    const fmt = (d: Date | string | null) => {
      if (!d) return 'the original date';
      const dd = typeof d === 'string' ? new Date(d) : d;
      return Number.isNaN(dd.getTime()) ? String(d) : businessDateKey(dd);
    };
    const branchName = (schedule.assignment as any)?.projectBranch?.branch?.name ?? 'the branch';

    if (targetStatus === ScheduleStatus.RESCHEDULED && newScheduledDate) {
      this.notificationDispatch.emitSafe({
        type: 'SCHEDULE_RESCHEDULED',
        entityType: 'SCHEDULE',
        entityId: saved.id,
        actorUserId: userId,
        assayerId: saved.assayerId,
        // Per occurrence, not per date: A → B → A → B is four moves, and the second B is news.
        dedupeKey: `SCHEDULE_RESCHEDULED:${saved.id}:${newScheduledDate}${redatedVersion ? `:${redatedVersion}` : ''}`,
        payload: {
          assignmentId: saved.assignmentId,
          branchName,
          previousDate: fmt(previousDate),
          newDate: newScheduledDate,
        },
      });
    }

    // A SCHEDULE_CANCELLED notice was raised here for a status ScheduleStatus does not have, so it
    // could never fire; it and its catalog entry were removed (2026-09-24). An assayer hears about a
    // called-off visit through the assignment's own cancellation (ASSIGNMENT_CANCELLED).

    try {
      this.eventPublisher.publish('schedule:updated', {
        eventType: 'schedule:updated',
        scheduleId: saved.id,
        assignmentId: saved.assignmentId,
        assayerId: saved.assayerId,
        scheduledDate: saved.scheduledDate,
        status: saved.status,
        previousStatus: prevStatus,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish schedule:updated event:', err);
    }

    return saved;
  }

  async getAssayerWorkloadInRange(
    assayerId: string,
    from: Date,
    to: Date,
  ): Promise<{ count: number; weeklyCapacity: number; schedules: any[] }> {
    // The assayer's own ceiling when they have one, otherwise the platform default the planning
    // engines already use — one number, so the desk and the engines cannot disagree about
    // whether someone is full.
    const row = await this.scheduleRepository.manager
      .query(`SELECT max_weekly_workload FROM assayers WHERE id = $1 LIMIT 1`, [assayerId])
      .catch(() => []);
    const assayerCapacity = Number(row?.[0]?.max_weekly_workload) || DEFAULT_WEEKLY_CAPACITY;

    const schedules = await this.scheduleRepository.find({
      where: {
        assayerId,
        isActive: true,
        // `Between`, not `{gte, lte}`. TypeORM serialises a plain object as a literal JSON
        // string into the SQL and Postgres rejects it — the same defect the sibling query above
        // documents having fixed. The frontend swallows the resulting error
        // (`catch { setAssayerWorkload(null); }`), so the over-booking banner this feeds simply
        // never rendered and nobody noticed the endpoint was dead.
        scheduledDate: Between(from, to),
      },
      relations: ['assignment', 'project'],
      order: { scheduledDate: 'ASC' },
    });
    return {
      // The ceiling travels with the count. The desk hardcoded 3 — the DAILY cap — against this
      // WEEKLY window, so it painted a red over-booked warning at a fifth of the real limit while
      // the planning engines were recommending the same assayer as having room for twelve more.
      weeklyCapacity: assayerCapacity,
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
