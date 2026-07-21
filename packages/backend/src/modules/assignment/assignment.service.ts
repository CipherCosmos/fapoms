import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
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
export class AssignmentService {
  constructor(
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly holidayService: HolidayService,
    private readonly auditService: AuditService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity> {
    const projectBranch = await this.projectBranchRepository.findOne({
      where: { id: dto.projectBranchId, isActive: true },
      relations: ['branch'],
    });

    if (!projectBranch) {
      throw new NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
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

    // Create the assignment record starting in CREATED status
    const assignment = this.assignmentRepository.create({
      assignmentNumber,
      projectBranchId: projectBranch.id,
      projectId: projectBranch.projectId,
      assayerId: dto.assayerId,
      status: AssignmentStatus.CREATED,
      proposedFee: dto.proposedFee,
      agreedFee: null,
      scheduledDate: scheduledDateObj,
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

    if (!isValidTransition(ASSIGNMENT_TRANSITIONS, prevStatus, targetStatus)) {
      throw new BadRequestException(
        `Invalid Transition: Cannot transition assignment from ${prevStatus} to ${targetStatus}.`
      );
    }

    assignment.status = targetStatus;
    if (remarks) assignment.remarks = remarks;

    // Apply state-specific transition rules
    if (targetStatus === AssignmentStatus.REJECTED) {
      assignment.rejectReason = reason ?? remarks ?? 'Rejected by Assayer';
      assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
    } else if (targetStatus === AssignmentStatus.CANCELLED) {
      assignment.cancelReason = reason ?? remarks ?? 'Cancelled by Admin';
      assignment.projectBranch.status = ProjectBranchStatus.CANDIDATE_SEARCH;
    } else if (targetStatus === AssignmentStatus.ACCEPTED) {
      if (fee) assignment.agreedFee = fee;
      else assignment.agreedFee = assignment.proposedFee;
      assignment.projectBranch.status = ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
    } else if (targetStatus === AssignmentStatus.SCHEDULED) {
      if (scheduledDate) {
        const scheduledDateObj = new Date(scheduledDate);
        const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, assignment.projectBranch.branch.state);
        if (isHolidayConflict) {
          throw new BadRequestException(
            `Holiday Conflict: ${scheduledDate} is a holiday in ${assignment.projectBranch.branch.state}.`
          );
        }
        assignment.scheduledDate = scheduledDateObj;
        assignment.projectBranch.scheduledDate = scheduledDateObj;
      }
      assignment.projectBranch.status = ProjectBranchStatus.SCHEDULED;
    } else if (targetStatus === AssignmentStatus.AUDIT_COMPLETED) {
      assignment.completionDate = new Date();
      assignment.projectBranch.status = ProjectBranchStatus.AUDIT_COMPLETED;
    } else if (targetStatus === AssignmentStatus.CLOSED) {
      assignment.projectBranch.status = ProjectBranchStatus.CLOSED;
    }

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
}
