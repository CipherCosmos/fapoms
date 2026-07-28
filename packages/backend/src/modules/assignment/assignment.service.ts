import { Injectable, NotFoundException, BadRequestException, ConflictException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { AssignmentEntity } from './assignment.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { UserEntity } from '../user/user.entity';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { AssayerService } from '../assayer/assayer.service';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssignmentStateMachine } from './assignment.state-machine';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { ConstraintEvaluator } from '../planning/constraint.evaluator';
import { EventCategory, AssignmentStatus, ProjectBranchStatus, SystemRole, ASSIGNMENT_TRANSITIONS, isValidTransition } from '@fapoms/shared';

export interface CreateAssignmentDto {
  projectBranchId: string;
  assayerId: string;
  proposedFee: number;
  scheduledDate: string;
  remarks?: string;
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
export class AssignmentService implements OnModuleInit {
  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly projectQueryService: ProjectQueryService,
    private readonly projectService: ProjectService,
    private readonly assayerService: AssayerService,
    private readonly notificationService: NotificationService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
    private readonly workflowEngine: WorkflowEngine,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly constraintEvaluator: ConstraintEvaluator,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  onModuleInit() {
    this.workflowEngine.registerWorkflow('assignment', [
      {
        from: [AssignmentStatus.CREATED],
        to: AssignmentStatus.CANDIDATE_SELECTED,
        beforeTransition: async (ctx) => {
          // Candidate selected state initialization hook
        },
      },
      {
        from: [AssignmentStatus.CANDIDATE_SELECTED],
        to: AssignmentStatus.CONTACT_INITIATED,
        beforeTransition: async (ctx) => {
          // Contact initiated state initialization hook
        },
      },
      {
        from: [AssignmentStatus.CONTACT_INITIATED],
        to: AssignmentStatus.NEGOTIATION,
        beforeTransition: async (ctx) => {
          // Negotiation state initialization hook
        },
      },
      {
        from: [AssignmentStatus.CREATED, AssignmentStatus.CONTACT_INITIATED, AssignmentStatus.NEGOTIATION],
        to: AssignmentStatus.ACCEPTED,
        beforeTransition: async (ctx) => {
          const { assignment, fee } = ctx.payload;
          assignment.agreedFee = fee ?? assignment.proposedFee;
          assignment.projectBranch.status = ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
        },
      },
      {
        from: [AssignmentStatus.CREATED, AssignmentStatus.CANDIDATE_SELECTED, AssignmentStatus.CONTACT_INITIATED, AssignmentStatus.NEGOTIATION],
        to: AssignmentStatus.REJECTED,
        beforeTransition: async (ctx) => {
          const { assignment, reason, remarks, userId } = ctx.payload;
          assignment.rejectReason = reason ?? remarks ?? 'Rejected by Assayer';
          assignment.isActive = false; // Release assignment allocation
          
          if (assignment.projectBranch) {
            assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
            assignment.projectBranch.updatedBy = userId || 'SYSTEM';
          }
        },
      },
      {
        from: [
          AssignmentStatus.CREATED,
          AssignmentStatus.CANDIDATE_SELECTED,
          AssignmentStatus.CONTACT_INITIATED,
          AssignmentStatus.NEGOTIATION,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.SCHEDULED,
          AssignmentStatus.AUDIT_COMPLETED,
        ],
        to: AssignmentStatus.CANCELLED,
        beforeTransition: async (ctx) => {
          const { assignment, reason, remarks } = ctx.payload;
          assignment.cancelReason = reason ?? remarks ?? 'Cancelled by Admin';
          assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
        },
      },
      {
        from: [AssignmentStatus.ACCEPTED],
        to: AssignmentStatus.SCHEDULED,
        guards: [
          async (ctx) => {
            const { scheduledDate, state } = ctx.payload;
            if (scheduledDate) {
              const isHoliday = await this.holidayService.isHoliday(new Date(scheduledDate), state);
              if (isHoliday) {
                throw new BadRequestException(`Holiday Conflict: ${scheduledDate} is a holiday in ${state}.`);
              }
            }
            return true;
          },
        ],
        beforeTransition: async (ctx) => {
          const { assignment, scheduledDate } = ctx.payload;
          if (scheduledDate) {
            const scheduledDateObj = new Date(scheduledDate);
            assignment.scheduledDate = scheduledDateObj;
            assignment.projectBranch.scheduledDate = scheduledDateObj;
          }
          assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
        },
      },
      {
        from: [AssignmentStatus.SCHEDULED],
        to: AssignmentStatus.AUDIT_COMPLETED,
        beforeTransition: async (ctx) => {
          const { assignment } = ctx.payload;
          assignment.completionDate = new Date();
          assignment.projectBranch.status = ProjectBranchStatus.AUDIT_COMPLETED;
        },
      },
      {
        from: [AssignmentStatus.AUDIT_COMPLETED],
        to: AssignmentStatus.CLOSED,
        beforeTransition: async (ctx) => {
          const { assignment } = ctx.payload;
          assignment.projectBranch.status = ProjectBranchStatus.CLOSED;
        },
      },
    ]);
  }

  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity> {
    const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);

    if (!projectBranch) {
      throw new NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
    }

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
        AssignmentStatus.SCHEDULED,
        AssignmentStatus.AUDIT_COMPLETED,
        AssignmentStatus.CLOSED,
      ].includes(existingAssignment.status as any)
    ) {
      throw new ConflictException(
        `Branch Busy: An active/completed assignment (${existingAssignment.assignmentNumber}) already exists for this branch.`
      );
    }

    const scheduledDateObj = dto.scheduledDate ? new Date(dto.scheduledDate) : null;

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
      assignment.status = AssignmentStatus.CREATED;
      assignment.proposedFee = dto.proposedFee;
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
        projectId: projectBranch.projectId,
        assayerId: dto.assayerId,
        status: AssignmentStatus.CREATED,
        priority: projectBranch.priority,
        proposedFee: dto.proposedFee,
        agreedFee: null,
        scheduledDate: scheduledDateObj,
        syncToken: `SYNC-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        slaDueDate,
        slaStatus: 'COMPLIANT',
        remarks: dto.remarks ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
    }

    return this.dataSource.transaction(async (manager) => {
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
      try {
        let targetUserId = assayer.id;
        if (assayer.email) {
          const userObj = await this.dataSource.getRepository(UserEntity).findOne({ where: { email: assayer.email } }).catch(() => null);
          if (userObj) {
            targetUserId = userObj.id;
          }
        }

        await this.notificationService.create({
          userId: targetUserId,
          title: 'New Assignment',
          message: `You have been assigned to ${projectBranch.branch.name} on ${dto.scheduledDate}. Proposed fee: ₹${dto.proposedFee}.`,
          link: `/assignments/${saved.id}`,
        }, userId);

        await this.pushNotificationService.sendToUser(
          assayer.id,
          'New Assignment',
          `You have been assigned to ${projectBranch.branch.name} on ${dto.scheduledDate}. Fee: ₹${dto.proposedFee}.`,
          { assignmentId: saved.id, type: 'assignment_created' },
        );
      } catch (err) {
        console.error('Failed to send assignment creation notification:', err);
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

    if (
      assignment.status === AssignmentStatus.ACCEPTED ||
      assignment.status === AssignmentStatus.SCHEDULED ||
      assignment.status === AssignmentStatus.AUDIT_COMPLETED ||
      assignment.status === AssignmentStatus.CLOSED
    ) {
      throw new BadRequestException(
        `Locked: Cannot modify assignment details after acceptance (Current status: ${assignment.status}).`
      );
    }

    if (dto.proposedFee !== undefined) assignment.proposedFee = dto.proposedFee;
    if (dto.agreedFee !== undefined) assignment.agreedFee = dto.agreedFee;
    if (dto.scheduledDate !== undefined) {
      const scheduledDateObj = new Date(dto.scheduledDate);
      const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, assignment.projectBranch.branch.state);
      if (isHolidayConflict) {
        throw new BadRequestException(
          `Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${assignment.projectBranch.branch.state}.`
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

    return saved;
  }

  private async executeAssignmentTransition(
    id: string,
    targetStatus: AssignmentStatus,
    userId: string,
    remarks?: string,
    reason?: string,
    fee?: number,
    scheduledDate?: string,
    role = SystemRole.SUPER_ADMINISTRATOR,
  ): Promise<{ saved: AssignmentEntity; event: any }> {
    const validUserId = userId || (id && /^[0-9a-fA-F-]{36}$/.test(id) ? id : '00000000-0000-0000-0000-000000000000');
    userId = validUserId;

    const assignment = await this.findOne(id);
    const prevStatus = assignment.status;

    if (prevStatus === targetStatus) {
      return { saved: assignment, event: null };
    }

    let event: any;
    if (targetStatus === AssignmentStatus.CANDIDATE_SELECTED) {
      event = AssignmentStateMachine.selectCandidate(assignment, userId);
    } else if (targetStatus === AssignmentStatus.CONTACT_INITIATED) {
      event = AssignmentStateMachine.initiateContact(assignment, userId);
    } else if (targetStatus === AssignmentStatus.NEGOTIATION) {
      if (fee === undefined) throw new BadRequestException('Fee is required for negotiation.');
      event = AssignmentStateMachine.negotiate(assignment, fee, userId);
    } else if (targetStatus === AssignmentStatus.ACCEPTED) {
      event = AssignmentStateMachine.acceptOffer(assignment, userId, fee);
    } else if (targetStatus === AssignmentStatus.REJECTED) {
      event = AssignmentStateMachine.rejectOffer(assignment, userId, reason);
    } else if (targetStatus === AssignmentStatus.CANCELLED) {
      event = AssignmentStateMachine.cancel(assignment, userId, reason);
    } else if (targetStatus === AssignmentStatus.SCHEDULED) {
      if (!scheduledDate) throw new BadRequestException('Scheduled date is required.');
      event = AssignmentStateMachine.scheduleAudit(assignment, scheduledDate, userId);
    } else if (targetStatus === AssignmentStatus.AUDIT_COMPLETED) {
      event = AssignmentStateMachine.completeAudit(assignment, userId);
    } else if (targetStatus === AssignmentStatus.CLOSED) {
      event = AssignmentStateMachine.close(assignment, userId);
    } else {
      throw new BadRequestException(`Invalid assignment status: ${targetStatus}`);
    }

    const payload = { assignment, fee, reason, remarks, userId };
    return this.workflowEngine.executeCommand(
      'assignment',
      assignment.id,
      `${targetStatus}_Command`,
      prevStatus,
      targetStatus,
      userId,
      role,
      [],
      async () => {
        if (remarks) assignment.remarks = remarks;
        assignment.updatedBy = userId;
        assignment.projectBranch.updatedBy = userId;

        const saved = await this.dataSource.transaction(async (manager) => {
          if (targetStatus === AssignmentStatus.CANCELLED || targetStatus === AssignmentStatus.REJECTED) {
            await this.projectService.initiateBranchPlanning(assignment.projectBranch.id, userId, manager);
            assignment.projectBranch.status = ProjectBranchStatus.PLANNING;
          } else {
            const targetPBStatus = assignment.projectBranch.status as ProjectBranchStatus;
            if (targetPBStatus === ProjectBranchStatus.ASSIGNMENT_CONFIRMED) {
              await this.projectService.confirmBranchAssignment(assignment.projectBranch.id, userId, manager);
            } else if (targetPBStatus === ProjectBranchStatus.SCHEDULED) {
              await this.projectService.scheduleBranchAudit(assignment.projectBranch.id, userId, manager);
            } else if (targetPBStatus === ProjectBranchStatus.AUDIT_COMPLETED) {
              await this.projectService.completeBranchAudit(assignment.projectBranch.id, userId, manager);
            } else if (targetPBStatus === ProjectBranchStatus.CLOSED) {
              await this.projectService.closeBranchProject(assignment.projectBranch.id, userId, manager);
            } else if (targetPBStatus === ProjectBranchStatus.CANDIDATE_SEARCH) {
              await this.projectService.initiateBranchPlanning(assignment.projectBranch.id, userId, manager);
            }
          }

          const savedAssign = await manager.save(assignment);

          await this.auditService.recordEvent({
            category: EventCategory.OPERATIONAL,
            eventType: `ASSIGNMENT_${targetStatus}`,
            entityType: 'ASSIGNMENT',
            entityId: savedAssign.id,
            previousState: prevStatus,
            newState: targetStatus,
            userId,
            remarks: remarks ?? `Transitioned assignment to ${targetStatus}`,
          });

          // Trigger automatic state notifications
          try {
            if (targetStatus === AssignmentStatus.ACCEPTED) {
              await this.notificationService.create({
                userId: savedAssign.createdBy,
                title: `Assignment Accepted`,
                message: `Assignment offer ${savedAssign.assignmentNumber} has been accepted by the assayer.`,
              }, userId);
            } else if (targetStatus === AssignmentStatus.REJECTED) {
              await this.notificationService.create({
                userId: savedAssign.createdBy,
                title: `Assignment Rejected`,
                message: `Assignment offer ${savedAssign.assignmentNumber} was rejected. Reason: ${reason ?? remarks ?? 'None'}.`,
              }, userId);
            }
          } catch (err) {
            console.error('Failed to dispatch transition notification', err);
          }

          // Update assayer stats on terminal or completion states
          try {
            if (
              targetStatus === AssignmentStatus.AUDIT_COMPLETED ||
              targetStatus === AssignmentStatus.CLOSED ||
              targetStatus === AssignmentStatus.CANCELLED
            ) {
              await this.assayerService.updateAssayerStats(savedAssign.assayerId);
            }
          } catch (err) {
            console.error('Failed to update assayer stats', err);
          }

          return savedAssign;
        });

        return { saved, event };
      },
      payload,
    );
  }

  async transition(
    id: string,
    targetStatus: AssignmentStatus,
    userId: string,
    remarks?: string,
    reason?: string,
    fee?: number,
    scheduledDate?: string,
  ): Promise<AssignmentEntity> {
    if (targetStatus === AssignmentStatus.CANDIDATE_SELECTED) {
      return this.selectCandidate(id, userId, remarks);
    } else if (targetStatus === AssignmentStatus.CONTACT_INITIATED) {
      return this.initiateContact(id, userId, remarks);
    } else if (targetStatus === AssignmentStatus.NEGOTIATION) {
      if (fee === undefined) throw new BadRequestException('Fee is required for negotiation.');
      return this.negotiate(id, userId, fee, remarks);
    } else if (targetStatus === AssignmentStatus.ACCEPTED) {
      return this.acceptOffer(id, userId, fee, remarks);
    } else if (targetStatus === AssignmentStatus.REJECTED) {
      return this.rejectOffer(id, userId, reason, remarks);
    } else if (targetStatus === AssignmentStatus.CANCELLED) {
      return this.cancelAssignment(id, userId, reason, remarks);
    } else if (targetStatus === AssignmentStatus.SCHEDULED) {
      if (!scheduledDate) throw new BadRequestException('Scheduled date is required.');
      return this.scheduleAudit(id, userId, scheduledDate, remarks);
    } else if (targetStatus === AssignmentStatus.AUDIT_COMPLETED) {
      return this.completeAudit(id, userId, remarks);
    } else if (targetStatus === AssignmentStatus.CLOSED) {
      return this.closeAssignment(id, userId, remarks);
    } else {
      throw new BadRequestException(`Invalid assignment status transition to ${targetStatus}`);
    }
  }

  async selectCandidate(id: string, userId: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.CANDIDATE_SELECTED, userId, remarks);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async initiateContact(id: string, userId: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.CONTACT_INITIATED, userId, remarks);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async negotiate(id: string, userId: string, fee: number, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.NEGOTIATION, userId, remarks, undefined, fee);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async acceptOffer(id: string, userId: string, fee?: number, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.ACCEPTED, userId, remarks, undefined, fee);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async rejectOffer(id: string, userId: string, reason?: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.REJECTED, userId, remarks, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async scheduleAudit(id: string, userId: string, scheduledDate: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.SCHEDULED, userId, remarks, undefined, undefined, scheduledDate);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async completeAudit(id: string, userId: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.AUDIT_COMPLETED, userId, remarks);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async closeAssignment(id: string, userId: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.CLOSED, userId, remarks);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async cancelAssignment(id: string, userId: string, reason?: string, remarks?: string): Promise<AssignmentEntity> {
    const { saved, event } = await this.executeAssignmentTransition(id, AssignmentStatus.CANCELLED, userId, remarks, reason);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async findAll(page = 1, limit = 50, status?: string): Promise<{ assignments: AssignmentEntity[]; total: number }> {
    const where: any = {};
    if (status) where.status = status;
    const [assignments, total] = await this.assignmentRepository.findAndCount({
      where,
      relations: ['projectBranch', 'projectBranch.branch', 'assayer', 'project'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    return { assignments, total };
  }

  async findByAssayer(assayerId: string): Promise<AssignmentEntity[]> {
    return this.assignmentRepository.find({
      where: { assayerId },
      relations: ['projectBranch', 'projectBranch.branch', 'assayer', 'project'],
      order: { createdAt: 'DESC' },
    });
  }

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
    return this.dataSource.getRepository(AssignmentCommentEntity).save(commentRecord);
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
          AssignmentStatus.CREATED,
          AssignmentStatus.CANDIDATE_SELECTED,
          AssignmentStatus.CONTACT_INITIATED,
          AssignmentStatus.NEGOTIATION,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.SCHEDULED,
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
  ): Promise<{ success: boolean; assignment: AssignmentEntity; error?: string; message?: string }> {
    const assignment = await this.findOne(id);
    if (!assignment) {
      return { success: false, assignment: null as any, error: 'ASSIGNMENT_NOT_FOUND', message: 'Assignment not found.' };
    }

    if (syncToken && assignment.syncToken && syncToken !== assignment.syncToken) {
      return {
        success: false,
        assignment,
        error: 'CONFLICT_ASSIGNMENT_MODIFIED',
        message: 'Assignment state has changed on server. Please refresh schedule.',
      };
    }

    const timeStr = new Date().toISOString();
    const checkInRemarks = `GPS Checked in at (${lat}, ${lng}) on ${timeStr}`;
    assignment.remarks = assignment.remarks ? `${assignment.remarks} | ${checkInRemarks}` : checkInRemarks;
    assignment.updatedBy = userId || assignment.assayerId || id;
    assignment.syncToken = `SYNC-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    assignment.status = AssignmentStatus.SCHEDULED;

    // Transition ProjectBranch status to SCHEDULED / Execution tracking state
    if (assignment.projectBranch) {
      assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
      assignment.projectBranch.updatedBy = userId || assignment.assayerId || id;
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      if (assignment.projectBranch) {
        await manager.save(assignment.projectBranch);
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
        await this.notificationService.create({
          userId: saved.createdBy,
          title: 'Assayer GPS Check-In 📍',
          message: `Assayer ${saved.assayer?.displayName || 'Field Assayer'} checked in at ${saved.projectBranch?.branch?.name || 'Branch'} (${lat}, ${lng}).`,
          link: `/assignments/${saved.id}`,
        }, userId || saved.assayerId);
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
