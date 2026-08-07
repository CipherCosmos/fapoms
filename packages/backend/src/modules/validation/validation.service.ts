import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull} from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { ValidationStateMachine } from './validation.state-machine';
import { ProjectBranchEntity } from '../project/project-branch.entity';
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
      { from: [ValidationStatus.PENDING], to: ValidationStatus.ASSIGNED },
      { from: [ValidationStatus.ASSIGNED], to: ValidationStatus.OCR_PROCESSING },
      { from: [ValidationStatus.OCR_PROCESSING], to: ValidationStatus.HUMAN_REVIEW },
      /**
       * Hand-back straight to review, without passing through OCR.
       *
       * `getOrAdvanceForHandBack` explicitly handles a case sitting at PENDING — that is the
       * normal state, since `getOrCreateForBranch` opens every case at PENDING the moment a
       * packet is delegated. But this edge was never registered, so the workflow engine
       * rejected the very first hand-back of every packet. The caller in
       * `document.service.ts` catches and logs that, returning HTTP 200, so the operator saw
       * "handed back" while the case silently stayed put and never reached the head's review
       * queue. Work looked done and simply stopped moving.
       *
       * ASSIGNED is included for the same reason: a packet delegated to a member and typed up
       * without an OCR pass must still be able to reach review.
       */
      { from: [ValidationStatus.PENDING, ValidationStatus.ASSIGNED], to: ValidationStatus.HUMAN_REVIEW },
      { from: [ValidationStatus.HUMAN_REVIEW], to: ValidationStatus.APPROVED },
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

  async findAll(page = 1, limit = 50, projectBranchId?: string): Promise<{ validationCases: ValidationCaseEntity[]; total: number }> {
    const [validationCases, total] = await this.validationCaseRepository.findAndCount({
      where: { isActive: true, ...(projectBranchId ? { projectBranchId } : {}) },
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
      // `IsNull()`, not `undefined`. TypeORM drops an `undefined` value from the WHERE clause
      // altogether, so this read every PENDING case regardless of reviewer and then reassigned
      // them round-robin — quietly taking cases away from whoever already held them. Today the
      // two states rarely coexist (assignCase sets reviewer and status together), but the query
      // did not express the condition it relied on, so any path that set a reviewer without
      // moving the status would have caused silent reassignment.
      where: { status: ValidationStatus.PENDING, reviewerId: IsNull(), isActive: true },
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
    } else if (targetStatus === ValidationStatus.HUMAN_REVIEW) {
      return this.moveToReview(id, userId, remarks);
    } else {
      throw new BadRequestException(`Invalid validation status transition to ${targetStatus}`);
    }
  }

  /**
   * Transition a batch of validation cases to a target status as one operation.
   * Each row runs the normal per-case transition (state-machine validation,
   * branch/assessment side-effects, workflow command, audit). Per-row errors are
   * isolated so one bad case never aborts the rest.
   */
  async bulkTransition(
    ids: string[],
    targetStatus: ValidationStatus,
    userId: string,
    remarks?: string,
  ): Promise<{
    succeeded: { id: string; from: string; to: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const succeeded: { id: string; from: string; to: string }[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of ids) {
      try {
        const vCase = await this.findOne(id);
        const from = vCase.status;
        await this.transition(id, targetStatus, userId, remarks);
        succeeded.push({ id, from, to: targetStatus });
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }
    return { succeeded, failed };
  }

  async moveToReview(id: string, userId: string, remarks?: string): Promise<ValidationCaseEntity> {
    const validationCase = await this.findOne(id);
    const prevStatus = validationCase.status;
    return this.workflowEngine.executeCommand(
      'validation', validationCase.id, 'HUMAN_REVIEW_Command', prevStatus, ValidationStatus.HUMAN_REVIEW,
      userId, SystemRole.SUPER_ADMINISTRATOR, [],
      async () => {
        const event = ValidationStateMachine.moveToReview(validationCase, userId, remarks);
        validationCase.updatedBy = userId;
        const saved = await this.validationCaseRepository.save(validationCase);
        this.eventPublisher.publish(event.constructor.name, event);
        await this.auditService.recordEvent({
          category: EventCategory.WORKFLOW,
          eventType: 'VALIDATION_HUMAN_REVIEW',
          entityType: 'VALIDATION',
          entityId: saved.id,
          previousState: prevStatus,
          newState: ValidationStatus.HUMAN_REVIEW,
          userId,
          remarks: remarks ?? 'Ready for review',
        });
        return saved;
      },
    );
  }

  /**
   * Called when the data entry desk hands a packet back. Finds the case for this
   * project branch (creating one if this is its first time through review) and
   * advances it to HUMAN_REVIEW — the step that had no way to happen before this,
   * since documents and validation cases were two disconnected worlds.
   */
  async getOrAdvanceForHandBack(projectBranchId: string, assessmentId: string | null, userId: string): Promise<ValidationCaseEntity> {
    const validationCase = await this.getOrCreateForBranch(projectBranchId, assessmentId, userId);

    if (validationCase.status === ValidationStatus.CORRECTION_REQUIRED || validationCase.status === ValidationStatus.PENDING) {
      return this.moveToReview(validationCase.id, userId, 'Data entry complete — ready for review');
    }
    // Already ASSIGNED, HUMAN_REVIEW, or beyond: nothing to advance, hand-back is
    // just a repeat notification (e.g. a second packet for the same branch).
    return validationCase;
  }

  /**
   * Finds the case for a branch, or opens one at PENDING. Called as soon as a
   * packet is delegated for data entry — not only at hand-back — so a member can
   * raise a clarification about something they are still typing in, rather than
   * only after the head has it for review.
   */
  async getOrCreateForBranch(projectBranchId: string, assessmentId: string | null, userId: string): Promise<ValidationCaseEntity> {
    const existing = await this.validationCaseRepository.findOne({
      where: { projectBranchId, isActive: true },
      relations: ['projectBranch', 'projectBranch.branch', 'assessment', 'assessment.branch'],
    });
    if (existing) return existing;

    const created = await this.create({ projectBranchId, assessmentId: assessmentId ?? undefined }, userId);
    return this.findOne(created.id);
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
