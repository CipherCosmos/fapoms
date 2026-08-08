import { Inject, forwardRef, Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, Not, EntityManager } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { AssignmentEntity } from './assignment.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { CustomerMasterVersionEntity } from '../customer-master/customer-master-version.entity';
import { CustomerRecordEntity } from '../customer-master/customer-record.entity';
import { UserEntity } from '../user/user.entity';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerService } from '../assayer/assayer.service';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssignmentStateMachine } from './assignment.state-machine';
import { ProjectBranchStateMachine } from '../project/project.state-machine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';
import { ValidationService } from '../validation/validation.service';
import { DocumentService } from '../document/document.service';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { EventCategory, ScheduleStatus, AssignmentStatus, AssessmentStatus, ProjectBranchStatus, CustomerMasterStatus, Priority, SystemRole, calculateHaversineDistance } from '@fapoms/shared';

// Fee rates are no longer declared here. They resolve per client contract through
// FeePolicyService — see packages/backend/src/modules/pricing/fee-policy.service.ts.

const ASSESSMENT_STATUS_MAP: Record<ProjectBranchStatus, AssessmentStatus> = {
  [ProjectBranchStatus.IMPORTED]: AssessmentStatus.PENDING_PLANNING,
  [ProjectBranchStatus.PLANNING]: AssessmentStatus.PENDING_PLANNING,
  [ProjectBranchStatus.CANDIDATE_SEARCH]: AssessmentStatus.ASSESSOR_RECOMMENDED,
  [ProjectBranchStatus.CONTACT_INITIATED]: AssessmentStatus.IN_NEGOTIATION,
  [ProjectBranchStatus.NEGOTIATION]: AssessmentStatus.IN_NEGOTIATION,
  [ProjectBranchStatus.ASSIGNMENT_CONFIRMED]: AssessmentStatus.ASSIGNED_AND_SCHEDULED,
  [ProjectBranchStatus.SCHEDULED]: AssessmentStatus.ASSIGNED_AND_SCHEDULED,
  [ProjectBranchStatus.AUDIT_COMPLETED]: AssessmentStatus.AUDITED_PDF_RECEIVED,
  [ProjectBranchStatus.VALIDATION_COMPLETED]: AssessmentStatus.SENT_TO_DATA_ENTRY,
  [ProjectBranchStatus.CLOSED]: AssessmentStatus.COMPLETED,
  [ProjectBranchStatus.UNABLE_TO_COVER]: AssessmentStatus.UNASSIGNED,
  [ProjectBranchStatus.ON_HOLD]: AssessmentStatus.PENDING_PLANNING,
  [ProjectBranchStatus.CANCELLED]: AssessmentStatus.UNASSIGNED,
};

export interface CreateAssignmentDto {
  projectBranchId: string;
  assayerId: string;
  proposedFee?: number;
  scheduledDate?: string;
  remarks?: string;
  autoSchedule?: boolean;
}

export interface UpdateAssignmentDetailsDto {
  proposedFee?: number;
  agreedFee?: number;
  scheduledDate?: string;
  remarks?: string;
}

export interface TransitionAssignmentDto {
  targetStatus: AssignmentStatus;
  remarks?: string;
  reason?: string;
  fee?: number;
  scheduledDate?: string;
}

@Injectable()
export class AssignmentService {
  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
    private readonly projectQueryService: ProjectQueryService,
    private readonly projectService: ProjectService,
    private readonly assayerService: AssayerService,
    private readonly notificationService: NotificationService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly constraintEvaluator: ConstraintEvaluator,
    private readonly routingService: RoutingService,
    private readonly validationService: ValidationService,
    private readonly feePolicyService: FeePolicyService,
    @Inject(forwardRef(() => DocumentService))
    private readonly documentService: DocumentService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}



  /**
   * Bring an assignment's schedule row to COMPLETED, creating it if the assignment was never
   * scheduled through the Scheduling page.
   *
   * `schedules` is 1:1 with `assignments` and carries its own status, so the two can disagree.
   * They are kept aligned here, in the caller's transaction, through the entity manager —
   * previously this was hand-written SQL run outside any transaction, with failures logged to
   * the console and otherwise ignored. The `@OneToOne` on ScheduleEntity.assignment provides
   * the unique constraint that makes "one schedule per assignment" true at the database level,
   * so the find-or-create below cannot produce a duplicate.
   */
  private async syncScheduleCompletion(
    assignment: AssignmentEntity,
    userId: string,
    manager: EntityManager,
  ): Promise<void> {
    const scheduleRepo = manager.getRepository(ScheduleEntity);
    const existing = await scheduleRepo.findOne({ where: { assignmentId: assignment.id } });

    if (existing) {
      existing.status = ScheduleStatus.COMPLETED;
      // Preserved if already set: the first completion is the real one.
      existing.completedAt = existing.completedAt ?? new Date();
      existing.updatedBy = userId;
      await scheduleRepo.save(existing);
      return;
    }

    await scheduleRepo.save(
      scheduleRepo.create({
        assignmentId: assignment.id,
        projectId: assignment.projectId,
        assayerId: assignment.assayerId,
        scheduledDate: assignment.scheduledDate ?? new Date(),
        status: ScheduleStatus.COMPLETED,
        completedAt: new Date(),
        remarks: 'Completed audit',
        createdBy: userId,
        updatedBy: userId,
      }),
    );
  }

  private async syncAssessmentStatus(assignment: AssignmentEntity): Promise<void> {
    if (assignment.assessment && assignment.projectBranch) {
      const mapped = ASSESSMENT_STATUS_MAP[assignment.projectBranch.status];
      if (mapped && assignment.assessment.status !== mapped) {
        assignment.assessment.status = mapped;
        assignment.assessment.auditDate = assignment.projectBranch.scheduledDate;
        assignment.assessment.assignedAssessorId = assignment.assayerId;
        assignment.assessment.agreedFee = assignment.agreedFee;
        await this.assessmentRepository.save(assignment.assessment);
      }
    }
  }

  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity> {
    const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);

    if (!projectBranch) {
      throw new NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
    }

    // Guard: block new assignments for branches already completed or under validation
    const terminalBranchStatuses = ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'];
    if (terminalBranchStatuses.includes(projectBranch.status)) {
      throw new ConflictException(
        `Cannot assign: Branch "${projectBranch.branch?.name || dto.projectBranchId}" is already in ${projectBranch.status.replace(/_/g, ' ')} state. No further assignments are permitted.`
      );
    }

    const assessment = await this.assessmentRepository.findOne({
      where: { projectId: projectBranch.projectId, branchId: projectBranch.branchId, isActive: true },
    });

    // Validate Assayer exists and has the required skills/certifications
    const assayer = await this.assayerService.findOne(dto.assayerId);

    if (!assayer) {
      throw new NotFoundException(`Assayer ${dto.assayerId} not found.`);
    }

    // Validate skills and certifications via ConstraintEvaluator
    if (projectBranch.project) {
      const skillsCheck = this.constraintEvaluator.checkSkillsAndCertifications(assayer, projectBranch.project);
      if (!skillsCheck.passed) {
        throw new BadRequestException(skillsCheck.reason);
      }
    }

    // Check for any active or existing assignment for this branch
    const existingAssignment = await this.assignmentRepository.findOne({
      where: { projectBranchId: projectBranch.id },
      order: { createdAt: 'DESC' },
    });

    if (
      existingAssignment &&
      [
        AssignmentStatus.ACCEPTED,
        AssignmentStatus.CHECKED_IN,
        AssignmentStatus.IN_PROGRESS,
        AssignmentStatus.COMPLETED,
      ].includes(existingAssignment.status)
    ) {
      throw new ConflictException(
        `Branch Busy: An active/completed assignment (${existingAssignment.assignmentNumber}) already exists for this branch in state ${existingAssignment.status}.`
      );
    }

    // Dynamic Scheduled Date Resolution: Use provided date, project branch scheduled date, or fallback to current date (today)
    const targetDateStr = dto.scheduledDate || (projectBranch.scheduledDate ? (typeof projectBranch.scheduledDate === 'string' ? (projectBranch.scheduledDate as string).slice(0, 10) : (projectBranch.scheduledDate as Date).toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10));
    const scheduledDateObj = new Date(targetDateStr);

    // Dynamic Proposed Fee Calculation based on Assayer Base Fee + Calculated Travel Distance Allowance
    let resolvedProposedFee = dto.proposedFee;
    let calculatedTravelFee = 0;
    let distanceKm = 0;

    if (projectBranch.branch?.latitude && projectBranch.branch?.longitude && assayer.latitude && assayer.longitude) {
      try {
        const route = await this.routingService.calculateRoute(
          { latitude: Number(projectBranch.branch.latitude), longitude: Number(projectBranch.branch.longitude) },
          { latitude: Number(assayer.latitude), longitude: Number(assayer.longitude) }
        );
        distanceKm = route.distanceKm || 0;
      } catch (e) {
        // Routing unavailable — the quote below falls back to zero travel rather than
        // guessing a distance, so ops sees base fee only instead of a fabricated allowance.
      }
    }

    // One calculator, one rate card. The free-commute allowance and per-km rate come from
    // the client's contract, not from a constant in this file.
    const quote = await this.feePolicyService.quote({
      assayerId: assayer.id,
      clientId: projectBranch.project?.clientId ?? null,
      configuration: projectBranch.project?.client?.configuration ?? undefined,
      distanceKm,
      onDate: scheduledDateObj || new Date(),
    });
    const baseFee = quote.baseFee;
    calculatedTravelFee = quote.travelFee;

    if (resolvedProposedFee === undefined || resolvedProposedFee === null) {
      resolvedProposedFee = quote.total;
    } else {
      // A client-supplied fee is an operator override, not a free-form number. The Day Plan
      // screen sends its own `proposedFee`, and this branch used to accept it verbatim —
      // which is precisely how the two divergent formulas both reached the database. The
      // override is still honoured (ops genuinely negotiate), but it is now bounded, and
      // anything above the computed quote is recorded as a deliberate deviation rather
      // than silently becoming the price.
      const override = Number(resolvedProposedFee);
      if (!Number.isFinite(override) || override < 0) {
        throw new BadRequestException('Proposed fee must be a non-negative number.');
      }
      const ceiling = quote.total * 2;
      if (override > ceiling) {
        throw new BadRequestException(
          `Proposed fee ₹${override} exceeds twice the contracted quote (₹${quote.total}) for this branch and assayer. ` +
          `Raise the client's rate card if this is intended.`,
        );
      }
      resolvedProposedFee = override;
    }

    // Validate proposed date against Holiday calendar via ConstraintEvaluator
    if (scheduledDateObj) {
      const holidayCheck = await this.constraintEvaluator.checkHoliday(projectBranch.branch.state, scheduledDateObj);
      if (!holidayCheck.passed) {
        throw new BadRequestException(holidayCheck.reason);
      }

      // Validate Assayer availability and prevent double-booking via ConstraintEvaluator
      const doubleBookingCheck = await this.constraintEvaluator.checkDoubleBooking(dto.assayerId, scheduledDateObj);
      if (!doubleBookingCheck.passed) {
        throw new ConflictException(doubleBookingCheck.reason);
      }
    }

    // Resolve SLA timeframe
    let maxResponseTimeHours = 24;
    if (projectBranch.project?.client?.configuration?.maxResponseTimeHours) {
      maxResponseTimeHours = Number(projectBranch.project.client.configuration.maxResponseTimeHours);
    }
    const slaDueDate = new Date();
    slaDueDate.setHours(slaDueDate.getHours() + maxResponseTimeHours);

    let assignment: AssignmentEntity;
    const isReassignment = Boolean(existingAssignment);

    if (existingAssignment) {
      // Reuse existing assignment record for this branch to preserve single unified timeline
      assignment = existingAssignment;
      assignment.assayerId = dto.assayerId;
      assignment.status = AssignmentStatus.PENDING;
      assignment.proposedFee = resolvedProposedFee;
      assignment.agreedFee = null;
      assignment.scheduledDate = scheduledDateObj;
      assignment.cancelReason = null;
      assignment.rejectReason = null;
      assignment.completionDate = null;
      assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      assignment.slaDueDate = slaDueDate;
      assignment.slaStatus = 'COMPLIANT';
      assignment.updatedBy = userId;
      assignment.isActive = true;
    } else {
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const assignmentNumber = `ASN-${new Date().getFullYear()}-${randomSuffix}`;
      assignment = this.assignmentRepository.create({
        assignmentNumber,
        projectBranchId: projectBranch.id,
        assessmentId: assessment?.id || null,
        projectId: projectBranch.projectId,
        assayerId: dto.assayerId,
        status: AssignmentStatus.PENDING,
        priority: projectBranch.priority,
        proposedFee: resolvedProposedFee,
        agreedFee: null,
        scheduledDate: scheduledDateObj,
        autoSchedule: dto.autoSchedule ?? true,
        syncToken: `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        slaDueDate,
        slaStatus: 'COMPLIANT',
        remarks: dto.remarks ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    return this.dataSource.transaction(async (manager) => {
      if (projectBranch && !projectBranch.scheduledDate && scheduledDateObj) {
        projectBranch.scheduledDate = scheduledDateObj;
        await manager.save(projectBranch);
      }
      const savedAssignment = await manager.save(assignment);

      // Update ProjectBranch status to PLANNING (or appropriate transitional state)
      await this.projectService.initiateBranchPlanning(projectBranch.id, userId, manager);

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: isReassignment ? 'ASSIGNMENT_REASSIGNED' : 'ASSIGNMENT_CREATED',
        entityType: 'ASSIGNMENT',
        entityId: savedAssignment.id,
        userId,
        remarks: isReassignment
          ? `Reassigned branch ${projectBranch.branch.name} to assayer ${assayer.displayName}. Proposed fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`
          : `Created assignment offer for branch ${projectBranch.branch.name}. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
      });

      return savedAssignment;
    }).then(async (saved) => {
      // The offer notification.
      //
      // This previously tried to find a `users` row matching the assayer's
      // email and notify that — but assayers authenticate from the `assayers`
      // table and have no `users` row at all (0 of 25 match), so the in-app
      // half of this never fired once. The push half went out separately with
      // no record that it had, so a missed offer left no trace either way.
      // Both channels now go through one emit against the assayer's own id,
      // and the row records whether it actually arrived.
      this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_OFFERED',
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        actorUserId: userId,
        assayerId: assayer.id,
        ownerUserId: userId,
        dedupeKey: `ASSIGNMENT_OFFERED:${saved.id}`,
        payload: {
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          branchName: projectBranch.branch?.name ?? 'the branch',
          scheduledDate: dto.scheduledDate ?? 'a date to be confirmed',
          proposedFee: dto.proposedFee,
        },
      });

      // Emit real-time event
      try {
        this.eventPublisher.publish('assignment:created', {
          eventType: 'assignment:created',
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          assayerId: saved.assayerId,
          organizationId: (saved as any).projectBranch?.project?.organizationId,
          branchName: projectBranch.branch?.name,
          status: saved.status,
        });
      } catch (err) {
        console.error('Failed to publish assignment:created event:', err);
      }

      return saved;
    });
  }

  async findOne(id: string): Promise<AssignmentEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id },
      relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
    });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${id} not found.`);
    }
    return assignment;
  }

  async update(id: string, dto: UpdateAssignmentDetailsDto, userId: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.status !== AssignmentStatus.PENDING) {
      throw new BadRequestException(
        `Locked: Cannot modify assignment details in status ${assignment.status}.`
      );
    }

    if (dto.proposedFee !== undefined) assignment.proposedFee = dto.proposedFee;
    if (dto.agreedFee !== undefined) assignment.agreedFee = dto.agreedFee;
    if (dto.scheduledDate !== undefined) {
      const scheduledDateObj = new Date(dto.scheduledDate);
      const branchState = assignment.projectBranch?.branch?.state || assignment.assessment?.branch?.state || '';
      const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, branchState);
      if (isHolidayConflict) {
        throw new BadRequestException(
          `Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${branchState}.`
        );
      }
      assignment.scheduledDate = scheduledDateObj;
    }
    if (dto.remarks !== undefined) assignment.remarks = dto.remarks;
    assignment.updatedBy = userId;

    const saved = await this.assignmentRepository.save(assignment);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_UPDATED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: `Updated details for assignment ${saved.assignmentNumber}.`,
    });

    try {
      if (dto.proposedFee !== undefined || dto.agreedFee !== undefined) {
        this.eventPublisher.publish('assignment:fee-updated', {
          eventType: 'assignment:fee-updated',
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          proposedFee: saved.proposedFee,
          agreedFee: saved.agreedFee,
          assayerId: saved.assayerId,
          organizationId: (saved as any).projectBranch?.project?.organizationId,
          userId,
          timestamp: new Date(),
        });
      }
    } catch (err) {
      console.error('Failed to publish assignment:fee-updated event:', err);
    }

    return saved;
  }

  private async executeAssignmentTransition(
    id: string,
    targetStatus: AssignmentStatus,
    userId: string,
    reason?: string,
    fee?: number,
  ): Promise<{ saved: AssignmentEntity; event: any }> {
    const assignment = await this.findOne(id);
    const prevStatus = assignment.status;

    if (prevStatus === targetStatus && fee === undefined) {
      return { saved: assignment, event: null };
    }

    let event: any;
    let pbEvent: any;
    if (targetStatus === AssignmentStatus.ACCEPTED) {
      if (prevStatus !== targetStatus) {
        event = AssignmentStateMachine.acceptOffer(assignment, userId);
      }
      if (fee !== undefined && fee !== null) {
        assignment.proposedFee = fee;
        assignment.agreedFee = fee;
      } else if (!assignment.agreedFee && assignment.proposedFee) {
        assignment.agreedFee = assignment.proposedFee;
      }
      if (assignment.projectBranch && assignment.projectBranch.status !== ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
        pbEvent = ProjectBranchStateMachine.confirmAssignment(assignment.projectBranch, userId);
      }
      // If autoSchedule is enabled (or true by default), automatically create calendar dispatch packet upon acceptance
      if (assignment.autoSchedule !== false && assignment.scheduledDate) {
        const scheduleRepo = this.dataSource.getRepository('schedules');
        const existing = await scheduleRepo.findOne({ where: { assignmentId: assignment.id, isActive: true } }).catch(() => null);
        if (!existing) {
          await scheduleRepo.save({
            assignmentId: assignment.id,
            projectId: assignment.projectId,
            assayerId: assignment.assayerId,
            scheduledDate: assignment.scheduledDate,
            status: 'CONFIRMED',
            remarks: 'Auto-created upon offer acceptance (Direct Calendar Lock)',
            createdBy: userId,
            updatedBy: userId,
          }).catch(() => {});
        }
      }
    } else if (targetStatus === AssignmentStatus.REJECTED) {
      event = AssignmentStateMachine.rejectOffer(assignment, userId, reason);
      if (assignment.projectBranch) {
        assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
      }
    } else if (targetStatus === AssignmentStatus.CANCELLED) {
      event = AssignmentStateMachine.cancel(assignment, userId, reason);
      if (assignment.projectBranch) {
        assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
      }
    } else if (targetStatus === AssignmentStatus.COMPLETED) {
      event = { previousState: prevStatus, newState: AssignmentStatus.COMPLETED, userId };
      assignment.status = AssignmentStatus.COMPLETED;
      assignment.completionDate = new Date();
      if (assignment.projectBranch && assignment.projectBranch.status !== ProjectBranchStatus.AUDIT_COMPLETED) {
        pbEvent = ProjectBranchStateMachine.completeAudit(assignment.projectBranch, userId);
      }
      // The matching schedule row is brought to COMPLETED inside the transaction below,
      // via syncScheduleCompletion(). It used to happen here instead, as raw SQL issued on
      // `this.dataSource` — outside the transaction that saves the assignment, and with
      // `.catch(err => console.error(...))` swallowing any failure. Two consequences, both
      // real: if the assignment save below rolled back, the schedule was already COMPLETED
      // and stayed that way; and if the upsert itself failed, nothing surfaced it, leaving
      // `schedules.status` and `assignments.status` silently disagreeing about the same job.
    } else {
      throw new BadRequestException(`Invalid assignment status transition to ${targetStatus}`);
    }

    assignment.updatedBy = userId;

    await this.syncAssessmentStatus(assignment);

    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      if (assignment.assessment) {
        await manager.save(assignment.assessment);
      }
      const savedAssign = await manager.save(assignment);

      if (targetStatus === AssignmentStatus.COMPLETED) {
        // Inside the transaction: either both the assignment and its schedule reach
        // COMPLETED, or neither does.
        await this.syncScheduleCompletion(savedAssign, userId, manager);
      }

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: `ASSIGNMENT_${targetStatus}`,
        entityType: 'ASSIGNMENT',
        entityId: savedAssign.id,
        previousState: prevStatus,
        newState: targetStatus,
        userId,
        remarks: reason ?? `Transitioned assignment to ${targetStatus}`,
      });

      return savedAssign;
    });

    if (pbEvent) {
      this.eventPublisher.publish(pbEvent.constructor.name, pbEvent);
    }

    // Notifications.
    //
    // These used to go to `saved.createdBy` alone — the one person who happened
    // to raise the offer. If they were on leave, a rejection that needs a
    // same-day replacement reached nobody. Routing through the catalog sends it
    // to whoever currently holds the operations roles instead, so cover follows
    // the org chart rather than a stale user id.
    const notifyType =
      targetStatus === AssignmentStatus.ACCEPTED ? 'ASSIGNMENT_ACCEPTED'
      : targetStatus === AssignmentStatus.REJECTED ? 'ASSIGNMENT_REJECTED'
      : null;

    if (notifyType) {
      this.notificationDispatch.emitSafe({
        type: notifyType,
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        actorUserId: userId,
        assayerId: saved.assayerId,
        ownerUserId: saved.createdBy,
        // Status is part of the key so a later transition on the same
        // assignment is a new notification rather than a suppressed duplicate.
        dedupeKey: `${notifyType}:${saved.id}:${targetStatus}`,
        payload: {
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          assayerName: assignment.assayer
            ? `${assignment.assayer.firstName} ${assignment.assayer.lastName}`.trim()
            : 'The assayer',
          branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
          reason: reason ?? 'No reason given',
        },
      });
    }

    if (targetStatus === AssignmentStatus.COMPLETED) {
      try {
        if (saved.projectBranchId) {
          await this.validationService.create(
            {
              projectBranchId: saved.projectBranchId,
              assessmentId: saved.assessmentId || undefined,
            },
            userId,
          );
        }
      } catch (err) {
        console.error('Failed to auto-create validation case on completion:', err);
      }
    }

    try {
      await this.assayerService.updateAssayerStats(saved.assayerId);
    } catch (err) {
      console.error('Failed to update assayer stats', err);
    }

    return { saved, event };
  }

  async proposeCounterFee(id: string, userId: string, counterFee: number, remarks?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);
    const currentCount = assignment.negotiationCount || 0;
    if (currentCount >= 3) {
      // Auto-decline when negotiation round limit (3) is exceeded
      assignment.status = AssignmentStatus.REJECTED;
      assignment.rejectReason = 'Negotiation limit reached (3 counter-offers max). Offer auto-declined.';
      assignment.remarks = `Negotiation limit reached. Auto-declined.`;
      assignment.updatedBy = userId;
      if (assignment.projectBranch) {
        assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
      }
      return this.dataSource.transaction(async (manager) => {
        if (assignment.projectBranch) {
          await manager.save(assignment.projectBranch);
        }
        return manager.save(assignment);
      });
    }
    // Captured before the overwrite: a fee negotiation's audit value is the movement.
    const previousFee = assignment.proposedFee;

    assignment.negotiationCount = currentCount + 1;
    assignment.proposedFee = counterFee;
    assignment.remarks = remarks ?? `Counter offer #${assignment.negotiationCount} proposed: ₹${counterFee}`;
    assignment.updatedBy = userId;
    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.NEGOTIATION;
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      return manager.save(assignment);
    });

    /**
     * A counter-offer changes what this audit will cost, so it is a money decision and needs
     * a record. Nothing was written here: the assignment kept only the latest proposedFee, so
     * a negotiation that moved 1,200 -> 1,800 -> 1,500 left one number and no history of how
     * it got there or who moved it.
     */
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_COUNTER_OFFERED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: `Counter offer #${saved.negotiationCount}: ₹${previousFee ?? 'unset'} → ₹${counterFee}.`,
      metadata: {
        previousFee: previousFee ?? null,
        counterFee,
        negotiationRound: saved.negotiationCount,
        assayerId: saved.assayerId,
      },
    }).catch(() => { /* the counter-offer stands even if its audit row fails */ });

    try {
      this.eventPublisher.publish('assignment:counter-offered', {
        eventType: 'assignment:counter-offered',
        assignmentId: saved.id,
        assayerId: saved.assayerId,
        proposedFee: counterFee,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish counter offer event', err);
    }

    return saved;
  }

  async acceptOffer(id: string, userId: string, fee?: number, reason?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.ACCEPTED, userId, reason, fee);
    if (event) this.publishAssignmentEvent('assignment:status-changed', saved, event);
    return saved;
  }

  async rejectOffer(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.REJECTED, userId, reason);
    if (event) this.publishAssignmentEvent('assignment:status-changed', saved, event);
    return saved;
  }

  async cancelAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.CANCELLED, userId, reason);
    if (event) this.publishAssignmentEvent('assignment:status-changed', saved, event);
    return saved;
  }

  /**
   * Complete an assignment — sets completionDate, transitions branch to AUDIT_COMPLETED,
   * and auto-creates a validation case. Called when a schedule is marked COMPLETED.
   * This is the AUDIT workflow completion — separate from query/validation workflow.
   */
  async completeAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.COMPLETED, userId, reason);
    if (event) this.publishAssignmentEvent('assignment:status-changed', saved, event);
    return saved;
  }

  /**
   * Manually flags an assignment as urgent by bumping its priority to CRITICAL —
   * the only manual escalation path today; the SLA scanner's auto-decline
   * (checkSlaBreaches/autoDeclineExpiredOffers) is the sole automatic one.
   * Reuses the existing `priority` column rather than adding a separate
   * escalated flag/status.
   */
  async escalate(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.status === AssignmentStatus.COMPLETED) {
      throw new BadRequestException('Cannot escalate a completed assignment.');
    }

    const alreadyCritical = assignment.priority === Priority.CRITICAL;
    assignment.priority = Priority.CRITICAL;
    assignment.updatedBy = userId;
    const saved = await this.assignmentRepository.save(assignment);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_ESCALATED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: reason ?? `Assignment ${saved.assignmentNumber} escalated to CRITICAL priority.`,
    });

    // An escalation is precisely the case where notifying only the raiser is
    // wrong: it exists to pull in people who are not already watching. Goes to
    // operations *and* administrators.
    if (!alreadyCritical) {
      this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_ESCALATED',
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        actorUserId: userId,
        ownerUserId: saved.createdBy,
        dedupeKey: `ASSIGNMENT_ESCALATED:${saved.id}`,
        payload: {
          assignmentId: saved.id,
          assignmentNumber: saved.assignmentNumber,
          branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
          reason: reason ?? 'No reason given.',
        },
      });
    }

    this.publishAssignmentEvent('assignment:escalated', saved, { userId, previousState: assignment.status, timestamp: new Date() });

    return saved;
  }

  async scheduleAudit(id: string, userId: string, scheduledDate: string, remarks?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
      assignment.projectBranch.scheduledDate = new Date(scheduledDate);
      assignment.projectBranch.updatedBy = userId;
    }
    if (assignment.assessment) {
      assignment.assessment.auditDate = new Date(scheduledDate);
      assignment.assessment.status = AssessmentStatus.ASSIGNED_AND_SCHEDULED;
    }
    assignment.scheduledDate = new Date(scheduledDate);
    assignment.updatedBy = userId;

    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      if (assignment.assessment) {
        await manager.save(assignment.assessment);
      }
      return manager.save(assignment);
    });

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_SCHEDULED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      userId,
      remarks: remarks ?? `Scheduled audit for ${scheduledDate}.`,
    });

    this.publishAssignmentEvent('assignment:scheduled', saved, {
      previousState: saved.status,
      newState: saved.status,
      userId,
    });

    return saved;
  }

  private publishAssignmentEvent(eventType: string, assignment: AssignmentEntity, event: any) {
    this.eventPublisher.publish(eventType, {
      eventType,
      assignmentId: assignment.id,
      assignmentNumber: assignment.assignmentNumber,
      previousState: event.previousState || assignment.status,
      newState: assignment.status,
      assayerId: assignment.assayerId,
      organizationId: (assignment as any).projectBranch?.project?.organizationId,
      userId: event.userId,
      timestamp: event.timestamp || new Date(),
      metadata: event.metadata,
    });
  }

  async findAll(
    page = 1, limit = 50,
    status?: string,
    projectBranchStatus?: string,
    assessmentStatus?: string,
    unscheduledOnly?: boolean,
    priority?: string,
  ): Promise<{ assignments: AssignmentEntity[]; total: number }> {
    const where: any = {};
    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        where.status = statuses[0];
      } else if (statuses.length > 1) {
        where.status = In(statuses);
      }
    }
    if (projectBranchStatus) {
      const pbStatuses = projectBranchStatus.split(',').map((s) => s.trim()).filter(Boolean);
      if (pbStatuses.length === 1) {
        where.projectBranch = { status: pbStatuses[0] };
      } else if (pbStatuses.length > 1) {
        where.projectBranch = { status: In(pbStatuses) };
      }
    }
    if (assessmentStatus) {
      where.assessment = { status: assessmentStatus };
    }
    if (priority) {
      const priorities = priority.split(',').map((s) => s.trim()).filter(Boolean);
      if (priorities.length === 1) {
        where.priority = priorities[0];
      } else if (priorities.length > 1) {
        where.priority = In(priorities);
      }
    }

    if (unscheduledOnly) {
      const activeSchedules = await this.dataSource
        .getRepository('schedules')
        .find({ select: ['assignmentId'], where: { isActive: true } })
        .catch(() => []);
      const scheduledAsnIds = activeSchedules.map((s: any) => s.assignmentId).filter(Boolean);
      if (scheduledAsnIds.length > 0) {
        where.id = Not(In(scheduledAsnIds));
      }
    }

    const [assignments, total] = await this.assignmentRepository.findAndCount({
      where,
      relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch', 'assayer', 'project'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    return { assignments, total };
  }

  async findByAssayer(assayerId: string): Promise<AssignmentEntity[]> {
    const assignments = await this.assignmentRepository.find({
      where: {
        assayerId,
        status: In([
          AssignmentStatus.PENDING,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.CHECKED_IN,
          AssignmentStatus.IN_PROGRESS,
          AssignmentStatus.COMPLETED,
          AssignmentStatus.REJECTED,
          AssignmentStatus.CANCELLED,
        ]),
      },
      // `expenses` feeds the mobile earnings screen's claim total, which had no data source.
      relations: ['projectBranch', 'projectBranch.branch', 'assayer', 'project', 'expenses'],
      order: { createdAt: 'DESC' },
    });

    const projectIds = [...new Set(assignments.map((a) => a.projectBranch!.projectId))];
    const versionRepo = this.dataSource.getRepository(CustomerMasterVersionEntity);
    const recordRepo = this.dataSource.getRepository(CustomerRecordEntity);

    const projectVersions = new Map<string, CustomerMasterVersionEntity | null>();
    for (const projectId of projectIds) {
      const version = await versionRepo.findOne({
        where: { projectId, status: CustomerMasterStatus.APPROVED, isActive: true },
        order: { versionNumber: 'DESC' },
      });
      projectVersions.set(projectId, version);
    }

    const commercialProfileRepo = this.dataSource.getRepository(AssayerCommercialProfileEntity);
    const commProfile = await commercialProfileRepo.findOne({ where: { assayerId, isActive: true } }).catch(() => null);
    const baseFeeAmount = commProfile?.baseFee ? Number(commProfile.baseFee) : 1200;

    const queryRepo = this.dataSource.getRepository(ValidationQueryEntity);
    const caseRepo = this.dataSource.getRepository(ValidationCaseEntity);

    /**
     * Whether the branch's audit packet has actually been dispatched.
     *
     * Sent with the assignment so the field app can *gate* the download affordance instead of
     * offering it unconditionally and reporting "not available yet" only after the assayer
     * taps it. Batched into one query — this is the app's main list.
     */
    const readiness = await this.documentService.readinessForBranches(
      assignments.map((a) => a.projectBranchId).filter(Boolean) as string[],
    );

    for (const assignment of assignments) {
      (assignment as any).documentReadiness =
        readiness[assignment.projectBranchId as string] ??
        { state: 'NONE', dispatchedCount: 0, message: 'No audit paperwork has been prepared for this branch yet.' };

      // Named distinctly from proposedFee/agreedFee (the actual negotiated total for this
      // assignment, immutable once set) — this is only the assayer's CURRENT going rate,
      // for reference, and must never be conflated with what was actually agreed historically.
      (assignment as any).currentStandardBaseFee = baseFeeAmount;
      const version = projectVersions.get(assignment.projectBranch!.projectId);
      if (version) {
        const branchId = assignment.projectBranch!.branchId;
        const records = await recordRepo.find({
          where: { customerMasterVersionId: version.id, branchId, isActive: true },
        });
        (assignment as any).customerCount = records.length > 0 ? records.length : (assignment.projectBranch?.packetCount || 15);
        (assignment as any).customers = records;
      } else {
        (assignment as any).customerCount = assignment.projectBranch?.packetCount || 15;
        (assignment as any).customers = [];
      }

      // Fetch validation cases & queries for this assignment's projectBranchId
      if (assignment.projectBranchId) {
        const valCases = await caseRepo.find({
          where: { projectBranchId: assignment.projectBranchId, isActive: true },
        });
        if (valCases.length > 0) {
          const caseIds = valCases.map((c) => c.id);
          const queries = await queryRepo.find({
            where: { validationCaseId: In(caseIds), isActive: true },
            order: { createdAt: 'DESC' },
          });
          (assignment as any).queries = queries;
        } else {
          (assignment as any).queries = [];
        }
      } else {
        (assignment as any).queries = [];
      }
    }

    return assignments;
  }

  /**
   * Comments are the operational narrative on an assignment — why a date moved, what a branch
   * manager said. They were stored but never audited, so a comment could be added and the
   * comment row later removed with nothing showing it had existed.
   */
  async addComment(assignmentId: string, comment: string, userId: string, userName: string): Promise<AssignmentCommentEntity> {
    const assignment = await this.findOne(assignmentId);
    const commentRecord = this.dataSource.getRepository(AssignmentCommentEntity).create({
      assignmentId: assignment.id,
      userId,
      userName,
      comment,
      createdBy: userId,
      updatedBy: userId,
    });
    const saved = await this.dataSource.getRepository(AssignmentCommentEntity).save(commentRecord);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_COMMENT_ADDED',
      entityType: 'ASSIGNMENT',
      entityId: assignmentId,
      userId,
      remarks: comment.length > 200 ? `${comment.slice(0, 200)}…` : comment,
      metadata: { commentId: saved.id, authorName: userName },
    }).catch(() => { /* the comment stands even if its audit row fails */ });

    try {
      this.eventPublisher.publish('comment:added', {
        eventType: 'comment:added',
        assignmentId: assignment.id,
        commentId: saved.id,
        userId,
        userName,
        comment,
      });
    } catch (err) {
      console.error('Failed to publish comment:added event:', err);
    }

    return saved;
  }

  async getTimeline(assignmentId: string): Promise<any[]> {
    const assignment = await this.findOne(assignmentId);
    
    // Fetch audit history
    const { events } = await this.auditService.getEntityHistory('ASSIGNMENT', assignment.id, 100);
    
    // Fetch comments
    const comments = await this.dataSource.getRepository(AssignmentCommentEntity).find({
      where: { assignmentId: assignment.id, isActive: true },
      order: { createdAt: 'ASC' },
    });

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

    for (const c of comments) {
      timelineEvents.push({
        id: c.id,
        type: 'COMMENT',
        title: `Comment by ${c.userName}`,
        description: c.comment,
        timestamp: c.createdAt,
        user: c.userName,
      });
    }

    // Sort chronologically (most recent first)
    return timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async checkSlaBreaches(): Promise<number> {
    const now = new Date();
    const overdueAssignments = await this.assignmentRepository.find({
      where: {
        slaStatus: 'COMPLIANT',
        status: In([
          AssignmentStatus.PENDING,
          AssignmentStatus.ACCEPTED,
        ]),
        isActive: true,
      },
    });

    let breachedCount = 0;
    for (const assignment of overdueAssignments) {
      if (assignment.slaDueDate && assignment.slaDueDate < now) {
        assignment.slaStatus = 'BREACHED';
        await this.assignmentRepository.save(assignment);

        await this.auditService.recordEvent({
          category: EventCategory.SYSTEM,
          eventType: 'ASSIGNMENT_SLA_BREACHED',
          entityType: 'ASSIGNMENT',
          entityId: assignment.id,
          remarks: `SLA breach detected: Assignment ${assignment.assignmentNumber} exceeded response time deadline of ${assignment.slaDueDate}.`,
        });

        breachedCount++;
      }
    }

    return breachedCount;
  }

  /**
   * Auto-declines assignment offers still PENDING past their slaDueDate (response
   * deadline), so a non-responsive assayer never blocks a branch indefinitely.
   * Reuses rejectOffer() so the branch reverts to CANDIDATE_SEARCH, the original
   * assigning ops user is notified, and a realtime status-changed event fires —
   * identical to a manual rejection, just system-initiated.
   */
  async autoDeclineExpiredOffers(): Promise<number> {
    const now = new Date();
    const pendingOffers = await this.assignmentRepository.find({
      where: {
        status: AssignmentStatus.PENDING,
        isActive: true,
      },
    });

    let declinedCount = 0;
    for (const assignment of pendingOffers) {
      if (assignment.slaDueDate && assignment.slaDueDate < now) {
        try {
          await this.rejectOffer(assignment.id, 'SYSTEM', 'AUTO_DECLINED_SLA_EXPIRED');
          declinedCount++;

          // Reusing rejectOffer means ops was told the assayer *declined* — the same message
          // a real refusal produces. Operationally those are different situations: a decline
          // is an answer, a timeout means nobody responded at all and the assayer may not even
          // know they were offered the work. `ASSIGNMENT_AUTO_DECLINED` exists in the catalogue
          // for exactly this and had no code path able to emit it.
          const withBranch = await this.assignmentRepository
            .findOne({ where: { id: assignment.id }, relations: ['projectBranch', 'projectBranch.branch'] })
            .catch(() => null);

          this.notificationDispatch.emitSafe({
            type: 'ASSIGNMENT_AUTO_DECLINED',
            entityType: 'ASSIGNMENT',
            entityId: assignment.id,
            assayerId: assignment.assayerId,
            ownerUserId: assignment.createdBy ?? null,
            dedupeKey: `ASSIGNMENT_AUTO_DECLINED:${assignment.id}`,
            payload: {
              assignmentId: assignment.id,
              assignmentNumber: assignment.assignmentNumber,
              branchName: withBranch?.projectBranch?.branch?.name ?? 'A branch',
            },
          });
        } catch (err) {
          console.error(`Failed to auto-decline expired assignment ${assignment.id}:`, err);
        }
      }
    }

    return declinedCount;
  }

  async getDashboardSummary(): Promise<any> {
    const counts = await this.assignmentRepository
      .createQueryBuilder('assignment')
      .select('assignment.status', 'status')
      .addSelect('COUNT(assignment.id)', 'count')
      .where('assignment.isActive = :isActive', { isActive: true })
      .groupBy('assignment.status')
      .getRawMany();

    const slaCounts = await this.assignmentRepository
      .createQueryBuilder('assignment')
      .select('assignment.slaStatus', 'slaStatus')
      .addSelect('COUNT(assignment.id)', 'count')
      .where('assignment.isActive = :isActive', { isActive: true })
      .groupBy('assignment.slaStatus')
      .getRawMany();

    const summary: Record<string, number> = {};
    for (const c of counts) {
      summary[c.status] = Number(c.count);
    }

    const slaSummary: Record<string, number> = {};
    for (const s of slaCounts) {
      slaSummary[s.slaStatus] = Number(s.count);
    }

    return {
      statusCounts: summary,
      slaCounts: slaSummary,
    };
  }

  async recordCheckIn(
    id: string,
    lat: number,
    lng: number,
    syncToken?: string,
    userId?: string,
    accuracyMeters?: number,
  ): Promise<{ success: boolean; assignment: AssignmentEntity; error?: string; message?: string }> {
    const assignment = await this.findOne(id);
    if (!assignment) {
      return { success: false, assignment: null as any, error: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found.' };
    }

    /**
     * Only the assigned assayer may check in, and only from a state that means they were
     * actually expected on site.
     *
     * Neither rule existed. Any authenticated assayer could check in on ANY assignment by id,
     * and could do so directly from PENDING or REJECTED — recording attendance at a branch
     * they had never accepted, skipping the acceptance step entirely. Both produce a
     * falsified attendance record in what is meant to be bank audit evidence.
     *
     * Staff roles are allowed through so ops can correct a record on the assayer's behalf;
     * `updatedBy` preserves who actually performed it.
     */
    const actorIsAssignedAssayer = !!userId && userId === assignment.assayerId;
    if (!actorIsAssignedAssayer) {
      const actor = await this.dataSource
        .getRepository(UserEntity)
        .findOne({ where: { id: userId }, relations: ['roles'] })
        .catch(() => null);
      const actorRoles: string[] = (actor?.roles ?? []).map((r: any) => r?.name).filter(Boolean);
      const staffOverride = actorRoles.some((r) =>
        [
          SystemRole.SUPER_ADMINISTRATOR,
          SystemRole.ADMINISTRATOR,
          SystemRole.OPERATIONS_MANAGER,
        ].includes(r as SystemRole),
      );
      if (!staffOverride) {
        return {
          success: false,
          assignment,
          error: 'NOT_YOUR_ASSIGNMENT',
          message: 'You can only check in to an assignment that is assigned to you.',
        };
      }
    }

    const CHECK_IN_ALLOWED_FROM = [AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS];
    if (!CHECK_IN_ALLOWED_FROM.includes(assignment.status)) {
      return {
        success: false,
        assignment,
        error: 'INVALID_STATE_FOR_CHECK_IN',
        message: `You need to accept this assignment before checking in. It is currently ${String(assignment.status).replace(/_/g, ' ').toLowerCase()}.`,
      };
    }

    if (syncToken && assignment.syncToken && syncToken !== assignment.syncToken) {
      return {
        success: false,
        assignment,
        error: 'CONFLICT_ASSIGNMENT_MODIFIED',
        message: 'Assignment state has changed on server. Please refresh schedule.',
      };
    }

    /**
     * Check-in position is stored in real columns, not concatenated into `remarks`.
     *
     * It used to be written only as free text — `"GPS Checked in at (12.9, 77.5) on ..."` —
     * appended to a notes field. That cannot be queried, cannot be compared against the
     * branch's own coordinates, and cannot be produced as evidence in a dispute. The distance
     * from the branch is computed and stored now, so an out-of-geofence check-in is a fact on
     * the row rather than something nobody can ever discover.
     */
    const now = new Date();
    assignment.checkInLatitude = lat;
    assignment.checkInLongitude = lng;
    assignment.checkInAccuracyMeters = accuracyMeters ?? null;
    assignment.checkedInAt = now;

    const branchLat = Number(assignment.projectBranch?.branch?.latitude);
    const branchLng = Number(assignment.projectBranch?.branch?.longitude);
    assignment.checkInDistanceMeters =
      Number.isFinite(branchLat) && Number.isFinite(branchLng) && !(branchLat === 0 && branchLng === 0)
        ? Math.round(calculateHaversineDistance(lat, lng, branchLat, branchLng) * 1000)
        : null;

    assignment.status = AssignmentStatus.CHECKED_IN;
    assignment.updatedBy = userId || assignment.assayerId || id;
    assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
      if (!assignment.projectBranch.scheduledDate) {
        assignment.projectBranch.scheduledDate = assignment.scheduledDate || new Date();
      }
      assignment.projectBranch.updatedBy = userId || assignment.assayerId || id;
    }
    if (assignment.assessment) {
      assignment.assessment.status = AssessmentStatus.ASSIGNED_AND_SCHEDULED;
      assignment.assessment.auditDate = assignment.scheduledDate || new Date();
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
      }
      if (assignment.assessment) {
        await manager.save(assignment.assessment);
      }
      return manager.save(assignment);
    });

    // Record Audit Event for real-time operations control tracking
    try {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'ASSIGNMENT_CHECKED_IN',
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        userId: userId || saved.assayerId,
        remarks: `Assayer ${saved.assayer?.displayName || ''} GPS checked in at branch ${saved.projectBranch?.branch?.name || ''} (${lat}, ${lng}).`,
      });
    } catch (err) {
      console.error('Failed to log check-in audit event:', err);
    }

    // Send real-time notification to assignment creator / operations manager
    if (saved.createdBy) {
      try {
        const targetUser = await this.dataSource.getRepository(UserEntity).findOne({ where: { id: saved.createdBy } }).catch(() => null);
        if (targetUser) {
          await this.notificationService.create({
            userId: saved.createdBy,
            title: 'Assayer GPS Check-In',
            message: `Assayer ${saved.assayer?.displayName || 'Field Assayer'} checked in at ${saved.projectBranch?.branch?.name || 'Branch'} (${lat}, ${lng}).`,
            link: `/assignments/${saved.id}`,
          }, userId || saved.assayerId);
        }
      } catch (err) {
        console.error('Failed to dispatch check-in notification:', err);
      }
    }

    return {
      success: true,
      assignment: saved,
      message: `Checked in at ${lat}, ${lng}`,
    };
  }
}
