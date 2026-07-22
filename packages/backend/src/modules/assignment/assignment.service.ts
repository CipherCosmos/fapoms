import { Injectable, NotFoundException, BadRequestException, ConflictException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentCommentEntity } from './assignment-comment.entity';
import { NotificationService } from '../notifications/notification.service';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { EventCategory, AssignmentStatus, ProjectBranchStatus, ASSIGNMENT_TRANSITIONS, isValidTransition } from '@fapoms/shared';

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
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    private readonly notificationService: NotificationService,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
    private readonly workflowEngine: WorkflowEngine,
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
        from: [AssignmentStatus.CREATED, AssignmentStatus.NEGOTIATION],
        to: AssignmentStatus.ACCEPTED,
        beforeTransition: async (ctx) => {
          const { assignment, fee } = ctx.payload;
          assignment.agreedFee = fee ?? assignment.proposedFee;
          assignment.projectBranch.status = ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
        },
      },
      {
        from: [AssignmentStatus.CREATED, AssignmentStatus.NEGOTIATION],
        to: AssignmentStatus.REJECTED,
        beforeTransition: async (ctx) => {
          const { assignment, reason, remarks } = ctx.payload;
          assignment.rejectReason = reason ?? remarks ?? 'Rejected by Assayer';
          assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
        },
      },
      {
        from: [
          AssignmentStatus.CREATED,
          AssignmentStatus.CANDIDATE_SELECTED,
          AssignmentStatus.CONTACT_INITIATED,
          AssignmentStatus.NEGOTIATION,
          AssignmentStatus.ACCEPTED,
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
    const projectBranch = await this.projectBranchRepository.findOne({
      where: { id: dto.projectBranchId, isActive: true },
      relations: ['branch', 'project', 'project.client'],
    });

    if (!projectBranch) {
      throw new NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
    }

    // Validate Assayer exists and has the required skills/certifications
    const assayer = await this.assayerRepository.findOne({
      where: { id: dto.assayerId, isActive: true },
    });

    if (!assayer) {
      throw new NotFoundException(`Assayer ${dto.assayerId} not found.`);
    }

    if (projectBranch.project && projectBranch.project.requiredSkills && projectBranch.project.requiredSkills.length > 0) {
      const assayerSkills = assayer.skills || [];
      const missingSkills = projectBranch.project.requiredSkills.filter(
        (skill) => !assayerSkills.includes(skill)
      );
      if (missingSkills.length > 0) {
        throw new BadRequestException(
          `Assayer Qualification Conflict: Assayer lacks required skills: ${missingSkills.join(', ')}`
        );
      }
    }

    if (projectBranch.project && projectBranch.project.requiredCertifications && projectBranch.project.requiredCertifications.length > 0) {
      const assayerCerts = (assayer.certifications || []).map((c) => c.name);
      const missingCerts = projectBranch.project.requiredCertifications.filter(
        (cert) => !assayerCerts.includes(cert)
      );
      if (missingCerts.length > 0) {
        throw new BadRequestException(
          `Assayer Qualification Conflict: Assayer lacks required certifications: ${missingCerts.join(', ')}`
        );
      }
    }

    // Check for any active assignment for this branch
    const activeAssignment = await this.assignmentRepository.findOne({
      where: {
        projectBranchId: projectBranch.id,
        status: In([
          AssignmentStatus.CREATED,
          AssignmentStatus.CANDIDATE_SELECTED,
          AssignmentStatus.CONTACT_INITIATED,
          AssignmentStatus.NEGOTIATION,
          AssignmentStatus.ACCEPTED,
          AssignmentStatus.SCHEDULED,
          AssignmentStatus.AUDIT_COMPLETED,
          AssignmentStatus.CLOSED,
        ]),
        isActive: true,
      },
    });

    if (activeAssignment) {
      throw new ConflictException(
        `Branch Busy: An active assignment (${activeAssignment.assignmentNumber}) already exists for this branch.`
      );
    }

    const scheduledDateObj = new Date(dto.scheduledDate);

    // Validate proposed date against Holiday calendar
    const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, projectBranch.branch.state);
    if (isHolidayConflict) {
      throw new BadRequestException(
        `Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${projectBranch.branch.state}.`
      );
    }

    // Validate Assayer availability and prevent double-booking
    const isDoubleBooked = await this.assignmentRepository.findOne({
      where: {
        assayerId: dto.assayerId,
        scheduledDate: scheduledDateObj,
        status: In([AssignmentStatus.ACCEPTED, AssignmentStatus.SCHEDULED]),
        isActive: true,
      },
    });

    if (isDoubleBooked) {
      throw new ConflictException(
        `Assayer Collision: Assayer is already assigned to branch audit on ${dto.scheduledDate}.`
      );
    }

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const assignmentNumber = `ASN-${new Date().getFullYear()}-${randomSuffix}`;

    // Resolve SLA timeframe
    let maxResponseTimeHours = 24;
    if (projectBranch.project?.client?.configuration?.maxResponseTimeHours) {
      maxResponseTimeHours = Number(projectBranch.project.client.configuration.maxResponseTimeHours);
    }
    const slaDueDate = new Date();
    slaDueDate.setHours(slaDueDate.getHours() + maxResponseTimeHours);

    // Create the assignment record starting in CREATED status
    const assignment = this.assignmentRepository.create({
      assignmentNumber,
      projectBranchId: projectBranch.id,
      projectId: projectBranch.projectId,
      assayerId: dto.assayerId,
      status: AssignmentStatus.CREATED,
      priority: projectBranch.priority,
      proposedFee: dto.proposedFee,
      agreedFee: null,
      scheduledDate: scheduledDateObj,
      slaDueDate,
      slaStatus: 'COMPLIANT',
      remarks: dto.remarks ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    return this.dataSource.transaction(async (manager) => {
      const savedAssignment = await manager.save(assignment);

      // Update ProjectBranch status to PLANNING (or appropriate transitional state)
      projectBranch.status = ProjectBranchStatus.PLANNING;
      projectBranch.updatedBy = userId;
      await manager.save(projectBranch);

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'ASSIGNMENT_CREATED',
        entityType: 'ASSIGNMENT',
        entityId: savedAssignment.id,
        userId,
        remarks: `Created assignment offer for branch ${projectBranch.branch.name}. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
      });

      return savedAssignment;
    });
  }

  async findOne(id: string): Promise<AssignmentEntity> {
    const assignment = await this.assignmentRepository.findOne({
      where: { id, isActive: true },
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

  async transition(
    id: string,
    targetStatus: AssignmentStatus,
    userId: string,
    remarks?: string,
    reason?: string,
    fee?: number,
    scheduledDate?: string,
  ): Promise<AssignmentEntity> {
    const assignment = await this.findOne(id);
    const prevStatus = assignment.status;

    if (prevStatus === targetStatus) {
      return assignment;
    }

    await this.workflowEngine.executeTransition(
      'assignment',
      assignment.id,
      prevStatus,
      targetStatus,
      {
        userId,
        payload: {
          assignment,
          fee,
          scheduledDate,
          state: assignment.projectBranch.branch.state,
          reason,
          remarks,
        },
      },
    );

    assignment.status = targetStatus;
    if (remarks) assignment.remarks = remarks;

    assignment.updatedBy = userId;
    assignment.projectBranch.updatedBy = userId;

    return this.dataSource.transaction(async (manager) => {
      await manager.save(assignment.projectBranch);
      const saved = await manager.save(assignment);

      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: `ASSIGNMENT_${targetStatus}`,
        entityType: 'ASSIGNMENT',
        entityId: saved.id,
        previousState: prevStatus,
        newState: targetStatus,
        userId,
        remarks: remarks ?? `Transitioned assignment to ${targetStatus}`,
      });

      // Trigger automatic state notifications
      try {
        if (targetStatus === AssignmentStatus.ACCEPTED) {
          await this.notificationService.create({
            userId: saved.createdBy,
            title: `Assignment Accepted`,
            message: `Assignment offer ${saved.assignmentNumber} has been accepted by the assayer.`,
          }, userId);
        } else if (targetStatus === AssignmentStatus.REJECTED) {
          await this.notificationService.create({
            userId: saved.createdBy,
            title: `Assignment Rejected`,
            message: `Assignment offer ${saved.assignmentNumber} was rejected. Reason: ${reason ?? remarks ?? 'None'}.`,
          }, userId);
        }
      } catch (err) {
        console.error('Failed to dispatch transition notification', err);
      }

      return saved;
    });
  }

  async findAll(page = 1, limit = 50): Promise<{ assignments: AssignmentEntity[]; total: number }> {
    const [assignments, total] = await this.assignmentRepository.findAndCount({
      where: { isActive: true },
      relations: ['projectBranch', 'projectBranch.branch', 'assayer'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });

    return { assignments, total };
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
}
