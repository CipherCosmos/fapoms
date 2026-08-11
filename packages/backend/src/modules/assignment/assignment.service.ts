import { Inject, forwardRef, Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, Not, EntityManager } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { AssignmentEntity } from './assignment.entity';
import { OperationsInboxService } from './operations-inbox.service';
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
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { ProjectEntity } from '../project/project.entity';
import { COMMITTED_ASSIGNMENT_STATUSES } from './assignment-workload';
import { RoutingService } from '../geo/routing.provider';
import { ValidationService } from '../validation/validation.service';
import { DocumentService } from '../document/document.service';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { EventCategory, ScheduleStatus, AssignmentStatus, AssessmentStatus, ProjectBranchStatus, CustomerMasterStatus, Priority, SystemRole, calculateHaversineDistance, assignmentIssueCategoryLabel, isAssignmentTerminal } from '@fapoms/shared';
import { applyBranchScope, branchScopeWhere, needsBranchJoin } from '../../infrastructure/scope/apply-scope';
import { GlobalScope } from '../../infrastructure/scope/global-scope';

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
    private readonly operationsInbox: OperationsInboxService,
    private readonly routingService: RoutingService,
    private readonly validationService: ValidationService,
    private readonly feePolicyService: FeePolicyService,
    @Inject(forwardRef(() => DocumentService))
    private readonly documentService: DocumentService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly uow: UnitOfWork,
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
      const skillsCheck = this.constraintEvaluator.checkSkillsAndCertifications(assayer, projectBranch.project, dto.scheduledDate ? new Date(dto.scheduledDate) : undefined);
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

    // Home, not the live fix: this distance sets the travel allowance actually billed, and a
    // fee that changes with where somebody's phone was that morning is not auditable.
    if (projectBranch.branch?.latitude && projectBranch.branch?.longitude && assayer.homeLatitude && assayer.homeLongitude) {
      try {
        const route = await this.routingService.calculateRoute(
          { latitude: Number(projectBranch.branch.latitude), longitude: Number(projectBranch.branch.longitude) },
          { latitude: Number(assayer.homeLatitude), longitude: Number(assayer.homeLongitude) }
        );
        distanceKm = route.distanceKm || 0;
      } catch (e) {
        // Routing unavailable — the quote below falls back to zero travel rather than
        // guessing a distance, so ops sees base fee only instead of a fabricated allowance.
      }
    }

    // The client's own territorial rules, enforced on the write path rather than merely
    // influencing a score. Without this an operator could assign an assayer living beside the
    // branch they are auditing — exactly what the minimum-distance rule exists to prevent —
    // simply by using the single-branch flow instead of the day planner.
    const distancePolicy = this.constraintEvaluator.checkDistancePolicy(
      projectBranch.project?.client?.planningPreferences,
      distanceKm > 0 ? distanceKm : null,
    );
    if (!distancePolicy.passed) {
      throw new BadRequestException(distancePolicy.reason);
    }

    /**
     * An assayer travels to a town once, so the day is charged travel once.
     *
     * Every assignment used to be quoted full travel from the assayer's home, so two branches
     * on the same street on the same day each paid the whole journey — the client was billed
     * twice for one trip, and the day planner's own estimate (which charges a shared route
     * once, and says so) never matched the assignments the plan went on to create.
     *
     * The first assignment of a day carries the travel; later ones on that same date are quoted
     * base fee only. Ordering is by creation, so this is stable regardless of which branch is
     * assigned first.
     */
    let chargeableDistanceKm = distanceKm;
    if (scheduledDateObj) {
      const alreadyTravellingThatDay = await this.assignmentRepository.findOne({
        where: {
          assayerId: assayer.id,
          scheduledDate: scheduledDateObj,
          status: In(COMMITTED_ASSIGNMENT_STATUSES.concat(AssignmentStatus.PENDING)),
          isActive: true,
        },
      });
      if (alreadyTravellingThatDay) {
        chargeableDistanceKm = 0;
      }
    }

    // One calculator, one rate card. The free-commute allowance and per-km rate come from
    // the client's contract, not from a constant in this file.
    const quote = await this.feePolicyService.quote({
      assayerId: assayer.id,
      clientId: projectBranch.project?.clientId ?? null,
      configuration: projectBranch.project?.client?.configuration ?? undefined,
      distanceKm: chargeableDistanceKm,
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
      // Reset per-assayer evidence and negotiation state. Reusing the record for a NEW assayer
      // must not carry over the previous assayer's GPS check-in (which would read as this
      // assayer having stood in the branch — falsified audit evidence) or their spent
      // negotiation rounds (which would auto-decline a fresh offer prematurely).
      assignment.checkInLatitude = null;
      assignment.checkInLongitude = null;
      assignment.checkInAccuracyMeters = null;
      assignment.checkInDistanceMeters = null;
      assignment.checkedInAt = null;
      assignment.negotiationCount = 0;
      assignment.priority = projectBranch.priority;
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

    return this.uow.run(async (manager, emit) => {
      if (projectBranch && !projectBranch.scheduledDate && scheduledDateObj) {
        projectBranch.scheduledDate = scheduledDateObj;
        await manager.save(projectBranch);
      }
      const savedAssignment = await manager.save(assignment);

      // Update ProjectBranch status to PLANNING (or appropriate transitional state)
      await this.projectService.initiateBranchPlanning(projectBranch.id, userId, manager);

      await this.auditService.recordEventSafe({
        category: EventCategory.OPERATIONAL,
        eventType: isReassignment ? 'ASSIGNMENT_REASSIGNED' : 'ASSIGNMENT_CREATED',
        entityType: 'ASSIGNMENT',
        entityId: savedAssignment.id,
        userId,
        remarks: isReassignment
          ? `Reassigned branch ${projectBranch.branch.name} to assayer ${assayer.displayName}. Proposed fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`
          : `Created assignment offer for branch ${projectBranch.branch.name}. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
      });

      // Through the outbox rather than a post-commit publish: the event now commits with the
      // assignment and is redelivered if the process dies before it reaches the gateway. The
      // try/catch this replaces could only log a lost event, never recover it.
      emit('assignment:created', {
        eventType: 'assignment:created',
        assignmentId: savedAssignment.id,
        assignmentNumber: savedAssignment.assignmentNumber,
        assayerId: savedAssignment.assayerId,
        organizationId: (savedAssignment as any).projectBranch?.project?.organizationId,
        branchName: projectBranch.branch?.name,
        status: savedAssignment.status,
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
      //
      // Stays outside the transaction on purpose: NotificationDispatchService is Bull-backed
      // and has its own durability, and a notification is a side effect of the offer, not part
      // of its atomic write.
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
      // Same gate as scheduleAudit and assignment creation. This used to check holidays only,
      // and via HolidayService directly rather than the evaluator, so an edit here could put an
      // assayer on a date they were on leave for or already committed to.
      const scheduledDateObj = new Date(dto.scheduledDate);
      const projectForDate = assignment.projectBranch?.projectId
        ? await this.dataSource.getRepository(ProjectEntity).findOne({ where: { id: assignment.projectBranch.projectId } })
        : null;
      const availability = await this.constraintEvaluator.checkDateAvailability({
        assayer: assignment.assayer ?? null,
        assayerId: assignment.assayerId,
        project: projectForDate,
        branchState: assignment.projectBranch?.branch?.state || assignment.assessment?.branch?.state || null,
        clientId: projectForDate?.clientId ?? null,
        scheduledDate: scheduledDateObj,
        excludeAssignmentId: assignment.id,
      });
      if (!availability.passed) {
        throw new BadRequestException(availability.reason);
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
          });
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
      // Validated: only CHECKED_IN/IN_PROGRESS may complete. Prevents marking un-visited work done
      // and auto-billing it (see AssignmentStateMachine.completeAudit).
      event = AssignmentStateMachine.completeAudit(assignment, userId);
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

    const saved = await this.uow.run(async (manager, emit) => {
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

      await this.auditService.recordEventSafe({
        category: EventCategory.WORKFLOW,
        eventType: `ASSIGNMENT_${targetStatus}`,
        entityType: 'ASSIGNMENT',
        entityId: savedAssign.id,
        previousState: prevStatus,
        newState: targetStatus,
        userId,
        remarks: reason ?? `Transitioned assignment to ${targetStatus}`,
      });

      // The status change is emitted through the outbox from inside the transaction, so it
      // commits atomically with the transition and survives a crash before delivery.
      //
      // This is the event billing's auto-bill listener consumes: a COMPLETED assignment that
      // committed but whose event was published post-commit by the raw publisher (as it was
      // before) would, if the process died in that window, never be billed and never create an
      // assayer payable — completed work, no invoice, no trace. Routing it here closes that.
      // Delivery is at-least-once; the billing listener is already idempotent (its
      // already-billed guards plus a Redis lock), which is the precondition for moving it here.
      if (event) {
        emit('assignment:status-changed', {
          eventType: 'assignment:status-changed',
          assignmentId: savedAssign.id,
          assignmentNumber: savedAssign.assignmentNumber,
          previousState: event.previousState || prevStatus,
          newState: savedAssign.status,
          assayerId: savedAssign.assayerId,
          organizationId: (savedAssign as any).projectBranch?.project?.organizationId,
          userId: event.userId,
          metadata: event.metadata,
        });
      }

      // The project-branch transition rides the same transaction. No named subscriber depends
      // on it being a class instance — only the realtime gateway's broadcast — so a plain
      // payload is equivalent and is what the outbox stores.
      if (pbEvent) {
        emit(pbEvent.constructor.name, { ...pbEvent });
      }

      return savedAssign;
    });

    // Notifications.
    //
    // These used to go to `saved.createdBy` alone — the one person who happened
    // to raise the offer. If they were on leave, a rejection that needs a
    // same-day replacement reached nobody. Routing through the catalog sends it
    // to whoever currently holds the operations roles instead, so cover follows
    // the org chart rather than a stale user id.
    // Cancellation is wired here rather than in cancelAssignment(): every cancel path — the
    // controller, and anything else reaching for the state machine — funnels through this
    // transition, so one emit here fires exactly once per commit and cannot fire on a rolled
    // back cancel. The assayer is a recipient (ASSIGNED_ASSAYER) because a cancelled job simply
    // disappears from their next fetch, with no other signal that it is gone.
    const notifyType =
      targetStatus === AssignmentStatus.ACCEPTED ? 'ASSIGNMENT_ACCEPTED'
      : targetStatus === AssignmentStatus.REJECTED ? 'ASSIGNMENT_REJECTED'
      : targetStatus === AssignmentStatus.CANCELLED ? 'ASSIGNMENT_CANCELLED'
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
          scheduledDate: saved.scheduledDate
            ? new Date(saved.scheduledDate).toISOString().slice(0, 10)
            : 'the scheduled date',
        },
      });
    }

    if (targetStatus === AssignmentStatus.COMPLETED) {
      try {
        if (saved.projectBranchId) {
          // getOrCreateForBranch (not create) so completion is idempotent: if a case
          // already exists for this branch — data-entry delegation opened one, or a
          // re-delivered completion event — it is reused rather than duplicated.
          await this.validationService.getOrCreateForBranch(
            saved.projectBranchId,
            saved.assessmentId ?? null,
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
    // A counter-offer only makes sense while the offer is still open. Without this guard it could
    // mutate proposedFee on a COMPLETED assignment (diverging from what was already billed) or
    // re-open a CANCELLED/CHECKED_IN branch by flipping it back to NEGOTIATION.
    if (assignment.status !== AssignmentStatus.PENDING) {
      throw new BadRequestException(
        `A counter-offer can only be made on an open offer (PENDING), not '${assignment.status}'.`,
      );
    }
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
      const autoDeclined = await this.dataSource.transaction(async (manager) => {
        if (assignment.projectBranch) {
          await manager.save(assignment.projectBranch);
        }
        return manager.save(assignment);
      });

      // This path put the branch back into CANDIDATE_SEARCH and told nobody, so the desk only
      // discovered the offer had died by noticing the branch was unstaffed. Same rejection
      // notification a manual decline produces, since ops has to act identically on both.
      this.notificationDispatch.emitSafe({
        type: 'ASSIGNMENT_REJECTED',
        entityType: 'ASSIGNMENT',
        entityId: autoDeclined.id,
        actorUserId: userId,
        assayerId: autoDeclined.assayerId,
        ownerUserId: autoDeclined.createdBy,
        dedupeKey: `ASSIGNMENT_REJECTED:${autoDeclined.id}:NEGOTIATION_LIMIT`,
        payload: {
          assignmentId: autoDeclined.id,
          assignmentNumber: autoDeclined.assignmentNumber,
          assayerName: assignment.assayer
            ? `${assignment.assayer.firstName} ${assignment.assayer.lastName}`.trim()
            : 'The assayer',
          branchName: assignment.projectBranch?.branch?.name ?? autoDeclined.assignmentNumber,
          reason: autoDeclined.rejectReason ?? 'Negotiation limit reached',
        },
      });

      return autoDeclined;
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
    });

    // The round number is in the dedupe key: each counter-offer is a fresh price ops must
    // answer, so round 2 must not be swallowed as a duplicate of round 1.
    this.notificationDispatch.emitSafe({
      type: 'ASSIGNMENT_COUNTER_OFFERED',
      entityType: 'ASSIGNMENT',
      entityId: saved.id,
      actorUserId: userId,
      assayerId: saved.assayerId,
      ownerUserId: saved.createdBy,
      dedupeKey: `ASSIGNMENT_COUNTER_OFFERED:${saved.id}:${saved.negotiationCount}`,
      payload: {
        assignmentId: saved.id,
        assignmentNumber: saved.assignmentNumber,
        assayerName: assignment.assayer
          ? `${assignment.assayer.firstName} ${assignment.assayer.lastName}`.trim()
          : 'The assayer',
        proposedFee: counterFee,
        branchName: assignment.projectBranch?.branch?.name ?? saved.assignmentNumber,
        reason: remarks ?? 'No reason given',
      },
    });

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
    // The status-changed event is emitted inside executeAssignmentTransition's transaction now
    // (through the outbox), so callers no longer publish it afterwards.
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.ACCEPTED, userId, reason, fee);
    return saved;
  }

  async rejectOffer(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.REJECTED, userId, reason);
    return saved;
  }

  async cancelAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.CANCELLED, userId, reason);
    return saved;
  }

  /**
   * Complete an assignment — sets completionDate, transitions branch to AUDIT_COMPLETED,
   * and auto-creates a validation case. Called when a schedule is marked COMPLETED.
   * This is the AUDIT workflow completion — separate from query/validation workflow.
   */
  async completeAssignment(id: string, userId: string, reason?: string): Promise<AssignmentEntity> {
    const { saved } = await this.executeAssignmentTransition(id, AssignmentStatus.COMPLETED, userId, reason);
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

    await this.auditService.recordEventSafe({
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

  /**
   * An assayer flags a problem on their own assignment to the operations desk.
   *
   * The field app deliberately cannot cancel or reassign work — those are back-office
   * decisions (see the transition controller). But before this the assayer had no way to tell
   * the desk anything on their own initiative either: queries are desk-initiated, escalation
   * is ops-only. So an assayer standing at a shut branch, or one who has fallen ill the morning
   * of an audit, could only phone someone — nothing was recorded, and the desk had no signal in
   * the system to act on.
   *
   * This is that missing signal. It changes no status and frees no branch; it records the flag,
   * notifies the assigning user and operations, and emits a realtime event so the desk can then
   * take the back-office action (reassign, reschedule, cancel) that remains theirs to take.
   */
  async reportIssue(
    id: string,
    userId: string,
    category: string,
    note?: string,
  ): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    if (assignment.status === AssignmentStatus.COMPLETED) {
      throw new BadRequestException('This assignment is already completed.');
    }

    const branchName = assignment.projectBranch?.branch?.name ?? assignment.assignmentNumber;
    const summary = `${assignmentIssueCategoryLabel(category)}${note ? `: ${note}` : ''}`;

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_ISSUE_REPORTED',
      entityType: 'ASSIGNMENT',
      entityId: assignment.id,
      userId,
      remarks: `Assayer flagged ${assignment.assignmentNumber} (${branchName}) — ${summary}`,
      // Structured so the desk's field-issues view can render category and note without
      // re-parsing the remarks string.
      metadata: {
        category,
        categoryLabel: assignmentIssueCategoryLabel(category),
        note: note ?? '',
        assignmentNumber: assignment.assignmentNumber,
        branchName,
      },
    });

    this.notificationDispatch.emitSafe({
      type: 'ASSIGNMENT_ISSUE_REPORTED',
      entityType: 'ASSIGNMENT',
      entityId: assignment.id,
      actorUserId: userId,
      ownerUserId: assignment.createdBy,
      // Not deduped on the assignment alone — an assayer may legitimately flag the same job
      // twice (branch shut, then a safety concern), and each must reach the desk.
      payload: {
        assignmentId: assignment.id,
        assignmentNumber: assignment.assignmentNumber,
        branchName,
        category,
        categoryLabel: assignmentIssueCategoryLabel(category),
        note: note ?? '',
      },
    });

    this.publishAssignmentEvent('assignment:issue-reported', assignment, {
      userId,
      previousState: assignment.status,
      timestamp: new Date(),
    });

    return assignment;
  }

  /**
   * The desk's list of problems the field has flagged.
   *
   * Read from the audit log rather than a bespoke table: `reportIssue` already records every
   * flag as an `ASSIGNMENT_ISSUE_REPORTED` event with the category and note in its metadata, so
   * this needs no new schema. The list is self-clearing — an issue is "open" only while its
   * assignment is still actionable; once the desk reassigns, reschedules or cancels the job (or
   * it completes), `open` flips to false and it drops out of the default filter. That makes the
   * assignment's own state the source of truth for "handled", with no separate resolve step to
   * forget.
   */
  async listFieldIssues(scope?: Partial<GlobalScope>, limit = 100): Promise<any[]> {
    const { events } = await this.auditService.getByEventType('ASSIGNMENT_ISSUE_REPORTED', limit);
    if (events.length === 0) return [];

    // Batch-load the referenced assignments so the current status/branch/assayer is fresh,
    // rather than trusting the point-in-time metadata — and without a query per event.
    const ids = Array.from(new Set(events.map((e) => e.entityId).filter(Boolean)));
    // Scoped here rather than after the fact: an issue whose assignment falls outside the
    // operator's region simply drops out of `byId`, and the mapping below already skips events
    // with no matching assignment.
    const issueWhere: Record<string, unknown> = { id: In(ids) };
    const issueBranchWhere = branchScopeWhere(scope);
    if (issueBranchWhere) issueWhere.projectBranch = { branch: issueBranchWhere };
    if (scope?.projectId) issueWhere.projectId = scope.projectId;

    const assignments = await this.assignmentRepository.find({
      where: issueWhere,
      relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
    });
    const byId = new Map(assignments.map((a) => [a.id, a]));

    return events.map((e) => {
      const a = byId.get(e.entityId);
      const meta = (e.metadata ?? {}) as Record<string, any>;
      const open = !!a && !isAssignmentTerminal(a.status);
      return {
        id: e.id,
        reportedAt: e.occurredAt,
        assignmentId: e.entityId,
        assignmentNumber: a?.assignmentNumber ?? meta.assignmentNumber ?? null,
        branchName: a?.projectBranch?.branch?.name ?? meta.branchName ?? null,
        assayerName: a?.assayer?.displayName ?? e.userDisplayName ?? null,
        assayerId: a?.assayerId ?? null,
        category: meta.category ?? null,
        categoryLabel: meta.categoryLabel ?? null,
        note: meta.note ?? '',
        assignmentStatus: a?.status ?? null,
        open,
      };
    });
  }

  async scheduleAudit(id: string, userId: string, scheduledDate: string, remarks?: string): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);

    /**
     * The single gate every scheduled-date write passes through.
     *
     * SchedulingService.create ran leave, timeline and holiday checks; SchedulingService
     * .transition (the Reschedule button) ran none; and this function, which both of them
     * funnel into, validated nothing. An audit could be moved onto a registered bank holiday
     * or onto a date the assayer was on leave or already booked, and it was written to
     * schedules, assignments, project_branches and assessments without objection. Guarding
     * the funnel closes every one of those paths at once.
     */
    const scheduledDateObj = new Date(scheduledDate);
    const project = assignment.projectBranch?.projectId
      ? await this.dataSource.getRepository(ProjectEntity).findOne({ where: { id: assignment.projectBranch.projectId } })
      : null;

    const availability = await this.constraintEvaluator.checkDateAvailability({
      assayer: assignment.assayer ?? null,
      assayerId: assignment.assayerId,
      project,
      branchState: assignment.projectBranch?.branch?.state ?? null,
      clientId: project?.clientId ?? null,
      scheduledDate: scheduledDateObj,
      excludeAssignmentId: assignment.id,
    });
    if (!availability.passed) {
      throw new BadRequestException(availability.reason);
    }

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
    scope?: Partial<GlobalScope>,
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

    // The global scope reaches an assignment through its branch: assignment → project_branch →
    // branch, where region/state/zone live. Merged into the existing `projectBranch` clause
    // rather than assigned over it, so a `projectBranchStatus` filter set above survives.
    const branchWhere = branchScopeWhere(scope);
    if (branchWhere) {
      where.projectBranch = { ...(where.projectBranch ?? {}), branch: branchWhere };
    }
    if (scope?.projectId) where.projectId = scope.projectId;

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

    // The assayer's current going rate, resolved by the same calculator that prices the work.
    // This used to be a bare findOne with no date window and no ordering — an arbitrary profile
    // row won — falling back to a hardcoded 1200 that ignored the client's contracted rate.
    // The result is shown to the field worker on their phone as their own standard base fee,
    // so it must be the figure the platform would actually pay.
    const { baseFee: baseFeeAmount } = await this.feePolicyService.resolveBaseFee(
      assayerId,
      await this.feePolicyService.getRates(null),
      new Date(),
    );

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
    });

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

        // Only rows still COMPLIANT reach this branch (see the query above) and they are saved
        // as BREACHED first, so a row is notified on the flip and never again on later scans;
        // the per-assignment dedupe key is the second guard if a scan is retried mid-run.
        // Branch is looked up here rather than joined into the scan query so the extra read is
        // paid only for the handful of rows that actually breach.
        const withBranch = await this.assignmentRepository
          .findOne({ where: { id: assignment.id }, relations: ['projectBranch', 'projectBranch.branch'] })
          .catch(() => null);

        this.notificationDispatch.emitSafe({
          type: 'ASSIGNMENT_SLA_BREACHED',
          entityType: 'ASSIGNMENT',
          entityId: assignment.id,
          assayerId: assignment.assayerId,
          ownerUserId: assignment.createdBy ?? null,
          dedupeKey: `ASSIGNMENT_SLA_BREACHED:${assignment.id}`,
          payload: {
            assignmentId: assignment.id,
            assignmentNumber: assignment.assignmentNumber,
            branchName: withBranch?.projectBranch?.branch?.name ?? assignment.assignmentNumber,
            // No slaType column exists; the status the clock ran out in is what distinguishes
            // an unanswered offer from an accepted job that never got done.
            slaType: assignment.status === AssignmentStatus.PENDING ? 'response' : 'completion',
          },
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

    // Channel-aware: PHONE-channel assayers may never see an in-app offer, so "no in-app answer
    // in 24h" is not a decline — it is the desk's call task still in progress. Auto-declining
    // them killed offers mid-negotiation. Their offers only leave PENDING by a human recording
    // the call outcome in the Operations Inbox.
    const channels = await this.operationsInbox.resolveChannels(
      [...new Set(pendingOffers.map((a) => a.assayerId))],
    );

    let declinedCount = 0;
    for (const assignment of pendingOffers) {
      if (channels.get(assignment.assayerId) === 'PHONE') continue;
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

  async getDashboardSummary(scope?: Partial<GlobalScope>): Promise<any> {
    // These KPI tiles sit above the assignment list. Leaving them unscoped while the list below
    // is scoped is worse than not scoping either: the operator reads "42 in progress", counts 6
    // rows, and has no way to tell which number is lying.
    const countBy = (column: string, label: string) => {
      const qb = this.assignmentRepository
        .createQueryBuilder('assignment')
        .select(column, label)
        .addSelect('COUNT(assignment.id)', 'count')
        .where('assignment.isActive = :isActive', { isActive: true })
        .groupBy(column);

      if (needsBranchJoin(scope)) {
        // innerJoin, not innerJoinAndSelect: the branch is only here to be filtered on.
        qb.innerJoin('assignment.projectBranch', 'spb').innerJoin('spb.branch', 'sbranch');
        applyBranchScope(qb, scope, { branch: 'sbranch', project: 'spb' });
      }
      if (scope?.projectId) {
        qb.andWhere('assignment.project_id = :scopeProjectId', { scopeProjectId: scope.projectId });
      }
      return qb.getRawMany();
    };

    const counts = await countBy('assignment.status', 'status');
    const slaCounts = await countBy('assignment.slaStatus', 'slaStatus');

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
    // Staff status is decided once and reused: it gates both "whose assignment is this" and
    // the schedule/geofence guards below — ops correcting a record must not be blocked by
    // rules that exist to keep the assayer's own attendance honest.
    let staffOverride = false;
    if (!actorIsAssignedAssayer) {
      const actor = await this.dataSource
        .getRepository(UserEntity)
        .findOne({ where: { id: userId }, relations: ['roles'] })
        .catch(() => null);
      const actorRoles: string[] = (actor?.roles ?? []).map((r: any) => r?.name).filter(Boolean);
      staffOverride = actorRoles.some((r) =>
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

    // Distance from the branch, computed before anything is mutated so the geofence guard and
    // the stored evidence are one figure, not two computations that could disagree.
    const branchLat = Number(assignment.projectBranch?.branch?.latitude);
    const branchLng = Number(assignment.projectBranch?.branch?.longitude);
    const distanceMeters =
      Number.isFinite(branchLat) && Number.isFinite(branchLng) && !(branchLat === 0 && branchLng === 0)
        ? Math.round(calculateHaversineDistance(lat, lng, branchLat, branchLng) * 1000)
        : null;

    /**
     * Check-in is only honest on the scheduled day, from the branch's vicinity — enforced,
     * not merely recorded.
     *
     * Both facts were already captured (`checkInDistanceMeters`, `scheduledDate`) but nothing
     * acted on them, and production data shows the result: an assignment CHECKED_IN nine days
     * before its scheduled date, 677 km from the branch. In a bank-audit system the check-in
     * *is* the attendance evidence, so a record like that is not noise — it is a false
     * attestation the desk then relies on.
     *
     * Staff (`staffOverride`) bypass both rules: correcting a record on someone's behalf is
     * exactly the case where the guard must yield. The assayer themselves cannot.
     *
     * The date is compared as an IST calendar day. Branches and assayers are Indian; the
     * server's own timezone (UTC in the containers) must not decide which day it is in Sangli.
     */
    if (!staffOverride) {
      const scheduledIso = assignment.scheduledDate ?? assignment.projectBranch?.scheduledDate ?? null;
      if (scheduledIso) {
        const istDay = (d: Date | string) =>
          new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const today = istDay(new Date());
        const scheduled = istDay(scheduledIso);
        if (today !== scheduled) {
          const early = today < scheduled;
          return {
            success: false,
            assignment,
            error: 'NOT_SCHEDULED_TODAY',
            message: early
              ? `This audit is scheduled for ${new Date(scheduledIso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}. Check-in opens on the day itself — if the visit has genuinely moved, ask operations to reschedule it first.`
              : `This audit was scheduled for ${new Date(scheduledIso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })} and that day has passed. Ask operations to reschedule it before checking in.`,
          };
        }
      }

      /**
       * Geofence: 2 km around the branch, widened by the device's own reported accuracy so a
       * poor rural GPS fix is not punished. 2 km is far beyond geocoding noise for a branch
       * address while still making "677 km away" impossible. Skipped when the branch has no
       * coordinates — a guard that fires on missing master data would block legitimate work.
       */
      const GEOFENCE_METERS = 2000;
      if (distanceMeters != null) {
        const allowance = GEOFENCE_METERS + Math.max(0, accuracyMeters ?? 0);
        if (distanceMeters > allowance) {
          const km = (distanceMeters / 1000).toFixed(1);
          return {
            success: false,
            assignment,
            error: 'TOO_FAR_FROM_BRANCH',
            message: `You appear to be ${km} km from this branch. Check-in works only at the branch itself — if you are standing there, get clear sky for a GPS fix and try again.`,
          };
        }
      }
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
    assignment.checkInDistanceMeters = distanceMeters;

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
            // Left as a direct create rather than migrated to a catalog emit: the catalog has no
            // check-in type, and inventing one here would change who gets told (roles, not the
            // raiser) — a routing decision that belongs with the catalog, not this call site.
            // The link is corrected: `/assignments/:id` is not a frontend route, so every one of
            // these landed on the dashboard catch-all instead of the record.
            link: `/assignments?id=${saved.id}`,
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
