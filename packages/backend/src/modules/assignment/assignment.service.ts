/**
 * FAPOMS — Assignment Service
 *
 * Implements scheduling calendar validations (holidays, double booking checks)
 * and controls assignment commitments (Part 3 Modules 6 & 7, Part 5 §8 & §9).
 */

import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import { AssignmentEntity } from './assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { HolidayService } from '../holiday/holiday.service';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, AssignmentStatus, ProjectBranchStatus } from '@fapoms/shared';

export interface CreateAssignmentDto {
  projectBranchId: string;
  assayerId: string;
  proposedFee: number;
  scheduledDate: string;
  remarks?: string;
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
  ) {}

  async create(dto: CreateAssignmentDto, userId: string): Promise<AssignmentEntity> {
    // 1. Retrieve project branch and nested branch/state details
    const projectBranch = await this.projectBranchRepository.findOne({
      where: { id: dto.projectBranchId, isActive: true },
      relations: ['branch'],
    });

    if (!projectBranch) {
      throw new NotFoundException(`Project branch link ${dto.projectBranchId} not found.`);
    }

    const scheduledDateObj = new Date(dto.scheduledDate);

    // 2. Validate proposed date against Holiday calendar (Part 3 Module 6, Part 5 §8)
    const isHolidayConflict = await this.holidayService.isHoliday(scheduledDateObj, projectBranch.branch.state);
    if (isHolidayConflict) {
      throw new BadRequestException(
        `Holiday Conflict: ${dto.scheduledDate} is a national/bank holiday in ${projectBranch.branch.state}.`
      );
    }

    // 3. Validate Assayer availability and prevent double-booking (Part 3 Module 6, Part 5 §8)
    // Check if assayer has any active assignments on that specific date
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

    // 4. Create the assignment record (status set to ACCEPTED as commitment is confirmed)
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const assignmentNumber = `ASN-${new Date().getFullYear()}-${randomSuffix}`;

    const assignment = this.assignmentRepository.create({
      assignmentNumber,
      projectBranchId: projectBranch.id,
      projectId: projectBranch.projectId,
      assayerId: dto.assayerId,
      status: AssignmentStatus.ACCEPTED,
      proposedFee: dto.proposedFee,
      agreedFee: dto.proposedFee, // initial commitment match
      scheduledDate: scheduledDateObj,
      remarks: dto.remarks ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedAssignment = await this.assignmentRepository.save(assignment);

    // 5. Update ProjectBranch status to ASSIGNMENT_CONFIRMED (Part 6 §4)
    projectBranch.status = ProjectBranchStatus.ASSIGNMENT_CONFIRMED;
    projectBranch.scheduledDate = scheduledDateObj;
    projectBranch.updatedBy = userId;
    await this.projectBranchRepository.save(projectBranch);

    // 6. Record Audit Event trail
    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'ASSIGNMENT_ACCEPTED',
      entityType: 'ASSIGNMENT',
      entityId: savedAssignment.id,
      userId,
      remarks: `Assigned branch ${projectBranch.branch.name} to assayer. Fee: ₹${dto.proposedFee}, Date: ${dto.scheduledDate}.`,
    });

    return savedAssignment;
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
