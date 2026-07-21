import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, ValidationStatus, ProjectBranchStatus, VALIDATION_TRANSITIONS, isValidTransition } from '@fapoms/shared';

export interface CreateValidationCaseDto {
  projectBranchId: string;
}

@Injectable()
export class ValidationService {
  constructor(
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateValidationCaseDto, userId: string): Promise<ValidationCaseEntity> {
    const projectBranch = await this.projectBranchRepository.findOne({
      where: { id: dto.projectBranchId, isActive: true },
    });

    if (!projectBranch) {
      throw new NotFoundException(`ProjectBranch ${dto.projectBranchId} not found.`);
    }

    const validationCase = this.validationCaseRepository.create({
      projectBranchId: projectBranch.id,
      status: ValidationStatus.PENDING,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.validationCaseRepository.save(validationCase);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_STARTED',
      entityType: 'VALIDATION',
      entityId: saved.id,
      userId,
      remarks: `Validation pipeline initialized for project branch.`,
    });

    return saved;
  }

  async findOne(id: string): Promise<ValidationCaseEntity> {
    const validationCase = await this.validationCaseRepository.findOne({
      where: { id, isActive: true },
      relations: ['projectBranch', 'projectBranch.branch'],
    });
    if (!validationCase) {
      throw new NotFoundException(`ValidationCase ${id} not found.`);
    }
    return validationCase;
  }

  async findAll(page = 1, limit = 50): Promise<{ validationCases: ValidationCaseEntity[]; total: number }> {
    const [validationCases, total] = await this.validationCaseRepository.findAndCount({
      where: { isActive: true },
      relations: ['projectBranch', 'projectBranch.branch'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { validationCases, total };
  }

  async assign(id: string, reviewerId: string, userId: string): Promise<ValidationCaseEntity> {
    const validationCase = await this.findOne(id);
    const prevStatus = validationCase.status;

    if (!isValidTransition(VALIDATION_TRANSITIONS, prevStatus, ValidationStatus.ASSIGNED)) {
      throw new BadRequestException(`Invalid Transition: Cannot transition validation case from ${prevStatus} to ASSIGNED.`);
    }

    validationCase.status = ValidationStatus.ASSIGNED;
    validationCase.reviewerId = reviewerId;
    validationCase.updatedBy = userId;

    const saved = await this.validationCaseRepository.save(validationCase);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'VALIDATION_ASSIGNED',
      entityType: 'VALIDATION',
      entityId: saved.id,
      previousState: prevStatus,
      newState: ValidationStatus.ASSIGNED,
      userId,
      remarks: `Validation case assigned to reviewer ${reviewerId}.`,
    });

    return saved;
  }

  async transition(id: string, targetStatus: ValidationStatus, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity> {
    const validationCase = await this.findOne(id);
    const prevStatus = validationCase.status;

    if (!isValidTransition(VALIDATION_TRANSITIONS, prevStatus, targetStatus)) {
      throw new BadRequestException(`Invalid Transition: Cannot transition validation case from ${prevStatus} to ${targetStatus}.`);
    }

    validationCase.status = targetStatus;
    if (remarks) validationCase.remarks = remarks;
    if (notes) validationCase.correctionNotes = notes;
    if (ocrResult) validationCase.ocrResult = ocrResult;
    validationCase.updatedBy = userId;

    if (targetStatus === ValidationStatus.APPROVED) {
      validationCase.reviewedAt = new Date();
      validationCase.projectBranch.status = ProjectBranchStatus.VALIDATION_COMPLETED;
      await this.projectBranchRepository.save(validationCase.projectBranch);
    } else if (targetStatus === ValidationStatus.SUBMITTED) {
      validationCase.projectBranch.status = ProjectBranchStatus.CLOSED;
      await this.projectBranchRepository.save(validationCase.projectBranch);
    }

    const saved = await this.validationCaseRepository.save(validationCase);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: `VALIDATION_${targetStatus}`,
      entityType: 'VALIDATION',
      entityId: saved.id,
      previousState: prevStatus,
      newState: targetStatus,
      userId,
      remarks: remarks ?? `Transitioned validation case to ${targetStatus}`,
    });

    return saved;
  }
}
