import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { ValidationStateMachine } from './validation.state-machine';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, ValidationStatus, ProjectBranchStatus, AssessmentStatus, SystemRole, VALIDATION_TRANSITIONS, isValidTransition } from '@fapoms/shared';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';

export interface CreateValidationCaseDto {
  projectBranchId: string;
  assessmentId?: string;
}

@Injectable()
export class ValidationService implements OnModuleInit {
  constructor(
    @InjectRepository(ValidationCaseEntity)
    private readonly validationCaseRepository: Repository<ValidationCaseEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
    private readonly projectQueryService: ProjectQueryService,
    private readonly projectService: ProjectService,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly workflowEngine: WorkflowEngine,
  ) {}

  onModuleInit() {
    this.workflowEngine.registerWorkflow('validation', [
      { from: [ValidationStatus.HUMAN_REVIEW, ValidationStatus.ASSIGNED, ValidationStatus.PENDING], to: ValidationStatus.APPROVED },
      { from: [ValidationStatus.HUMAN_REVIEW], to: ValidationStatus.CORRECTION_REQUIRED },
      { from: [ValidationStatus.CORRECTION_REQUIRED], to: ValidationStatus.HUMAN_REVIEW },
      { from: [ValidationStatus.APPROVED], to: ValidationStatus.SUBMITTED },
    ]);
  }

  async create(dto: CreateValidationCaseDto, userId: string): Promise<ValidationCaseEntity> {
    const projectBranch = await this.projectQueryService.findProjectBranchById(dto.projectBranchId);

    if (!projectBranch) {
      throw new NotFoundException(`ProjectBranch ${dto.projectBranchId} not found.`);
    }

    let assessmentId: string | null = dto.assessmentId ?? null;
    if (!assessmentId) {
      const asmt = await this.assessmentRepository.findOne({
        where: { projectId: projectBranch.projectId, branchId: projectBranch.branchId, isActive: true },
      });
      if (asmt) assessmentId = asmt.id;
    }

    const validationCase = this.validationCaseRepository.create({
      projectBranchId: projectBranch.id,
      assessmentId,
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
      relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch'],
    });
    if (!validationCase) {
      throw new NotFoundException(`ValidationCase ${id} not found.`);
    }
    return validationCase;
  }

  async findAll(page = 1, limit = 50): Promise<{ validationCases: ValidationCaseEntity[]; total: number }> {
    const [validationCases, total] = await this.validationCaseRepository.findAndCount({
      where: { isActive: true },
      relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch'],
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

  async autoBalanceUnassignedCases(availableValidatorIds: string[], userId: string): Promise<number> {
    if (availableValidatorIds.length === 0) return 0;

    const unassignedCases = await this.validationCaseRepository.find({
      where: { status: ValidationStatus.PENDING, reviewerId: undefined as any, isActive: true },
      order: { createdAt: 'ASC' },
    });

    let assignedCount = 0;
    for (let i = 0; i < unassignedCases.length; i++) {
      const caseItem = unassignedCases[i];
      const validatorId = availableValidatorIds[i % availableValidatorIds.length];
      caseItem.reviewerId = validatorId;
      caseItem.status = ValidationStatus.ASSIGNED;
      caseItem.updatedBy = userId;
      await this.validationCaseRepository.save(caseItem);
      assignedCount++;
    }

    return assignedCount;
  }

  private async executeValidationTransition(
    id: string,
    targetStatus: ValidationStatus,
    userId: string,
    remarks?: string,
    notes?: string,
    ocrResult?: any,
    role = SystemRole.SUPER_ADMINISTRATOR,
  ): Promise<{ saved: ValidationCaseEntity; event: any }> {
    const validationCase = await this.findOne(id);
    const prevStatus = validationCase.status;

    let event: any;
    if (targetStatus === ValidationStatus.APPROVED) {
      event = ValidationStateMachine.approveValidation(validationCase, userId, remarks, notes, ocrResult);
    } else if (targetStatus === ValidationStatus.SUBMITTED) {
      event = ValidationStateMachine.submitValidation(validationCase, userId, remarks, notes, ocrResult);
    } else if (targetStatus === ValidationStatus.CORRECTION_REQUIRED) {
      event = ValidationStateMachine.requestCorrection(validationCase, userId, remarks, notes, ocrResult);
    } else {
      throw new BadRequestException(`Invalid validation status: ${targetStatus}`);
    }

    return this.workflowEngine.executeCommand(
      'validation',
      validationCase.id,
      `${targetStatus}_Command`,
      prevStatus,
      targetStatus,
      userId,
      role,
      [],
      async () => {
        if (targetStatus === ValidationStatus.APPROVED) {
          await this.projectService.completeBranchValidation(validationCase.projectBranch.id, userId);
        } else if (targetStatus === ValidationStatus.SUBMITTED) {
          await this.projectService.closeBranchProject(validationCase.projectBranch.id, userId);
        } else if (targetStatus === ValidationStatus.CORRECTION_REQUIRED) {
          await this.projectService.initiateBranchPlanning(validationCase.projectBranch.id, userId);
        }

        if (validationCase.assessmentId && validationCase.assessment) {
          if (targetStatus === ValidationStatus.APPROVED) {
            validationCase.assessment.status = AssessmentStatus.REPORT_FINALIZED;
          } else if (targetStatus === ValidationStatus.CORRECTION_REQUIRED) {
            validationCase.assessment.status = AssessmentStatus.DATA_ENTRY_IN_PROGRESS;
          } else if (targetStatus === ValidationStatus.SUBMITTED) {
            validationCase.assessment.status = AssessmentStatus.PENDING_HEAD_APPROVAL;
          }
          validationCase.assessment.updatedBy = userId;
          await this.assessmentRepository.save(validationCase.assessment);
        }

        validationCase.updatedBy = userId;
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

        return { saved, event };
      }
    );
  }

  async transition(
    id: string,
    targetStatus: ValidationStatus,
    userId: string,
    remarks?: string,
    notes?: string,
    ocrResult?: any,
  ): Promise<ValidationCaseEntity> {
    if (targetStatus === ValidationStatus.APPROVED) {
      return this.approveValidation(id, userId, remarks, notes, ocrResult);
    } else if (targetStatus === ValidationStatus.CORRECTION_REQUIRED) {
      return this.requestCorrection(id, userId, remarks, notes, ocrResult);
    } else if (targetStatus === ValidationStatus.SUBMITTED) {
      return this.submitValidation(id, userId, remarks, notes, ocrResult);
    } else {
      throw new BadRequestException(`Invalid validation status transition to ${targetStatus}`);
    }
  }

  async approveValidation(id: string, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity> {
    const { saved, event } = await this.executeValidationTransition(id, ValidationStatus.APPROVED, userId, remarks, notes, ocrResult);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async requestCorrection(id: string, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity> {
    const { saved, event } = await this.executeValidationTransition(id, ValidationStatus.CORRECTION_REQUIRED, userId, remarks, notes, ocrResult);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }

  async submitValidation(id: string, userId: string, remarks?: string, notes?: string, ocrResult?: any): Promise<ValidationCaseEntity> {
    const { saved, event } = await this.executeValidationTransition(id, ValidationStatus.SUBMITTED, userId, remarks, notes, ocrResult);
    if (event) this.eventPublisher.publish(event.constructor.name, event);
    return saved;
  }
}
