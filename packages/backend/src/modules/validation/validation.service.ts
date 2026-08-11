import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, In } from 'typeorm';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { ValidationStateMachine } from './validation.state-machine';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, ValidationStatus, ProjectBranchStatus, AssessmentStatus, SystemRole, VALIDATION_TRANSITIONS, isValidTransition, ValidationQueryStatus } from '@fapoms/shared';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

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
    @InjectRepository(ValidationQueryEntity)
    private readonly validationQueryRepository: Repository<ValidationQueryEntity>,
    private readonly projectQueryService: ProjectQueryService,
    private readonly projectService: ProjectService,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly workflowEngine: WorkflowEngine,
    private readonly notificationDispatch: NotificationDispatchService,
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

  async findAll(
    page = 1,
    limit = 50,
    projectBranchId?: string,
    status?: ValidationStatus,
    reviewerId?: string,
    search?: string,
    workedBy?: string,
  ): Promise<{ validationCases: ValidationCaseEntity[]; total: number }> {
    // Query builder rather than findAndCount: the queue filters on the BRANCH (search)
    // and on the packet's worker (workedBy), neither of which is a column of this table.
    const qb = this.validationCaseRepository
      .createQueryBuilder('vc')
      .leftJoinAndSelect('vc.projectBranch', 'pb')
      .leftJoinAndSelect('pb.branch', 'b')
      .leftJoinAndSelect('vc.assessment', 'a')
      .leftJoinAndSelect('a.branch', 'ab')
      .where('vc.isActive = true');

    if (projectBranchId) qb.andWhere('vc.projectBranchId = :pbid', { pbid: projectBranchId });
    if (status) qb.andWhere('vc.status = :status', { status });
    // 'none' answers the head's "what has nobody picked up yet?" — an IS NULL filter,
    // not an equality match.
    if (reviewerId === 'none') qb.andWhere('vc.reviewerId IS NULL');
    else if (reviewerId) qb.andWhere('vc.reviewerId = :rid', { rid: reviewerId });
    if (search) qb.andWhere('(b.name ILIKE :q OR b.branchCode ILIKE :q)', { q: `%${search}%` });
    // A validator's slice: cases for branches whose packet was delegated to them —
    // "where do MY handed-back reports stand" as a server-side filter, not a page-side
    // scan of the whole desk.
    if (workedBy) {
      qb.andWhere(
        'vc.projectBranchId IN (SELECT project_branch_id FROM documents WHERE assigned_to_user_id = :wid AND is_active = true AND project_branch_id IS NOT NULL)',
        { wid: workedBy },
      );
    }

    const [validationCases, total] = await qb
      .orderBy('vc.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // The board shows WHO is validating each case, so the uuid alone is useless to it.
    // One batched lookup, attached as `reviewerName` on each row.
    const reviewerIds = [...new Set(validationCases.map((c) => c.reviewerId).filter(Boolean))] as string[];
    if (reviewerIds.length > 0) {
      const rows: Array<{ id: string; name: string }> = await this.validationCaseRepository.manager.query(
        `SELECT id, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), username) AS name
           FROM users WHERE id = ANY($1)`,
        [reviewerIds],
      );
      const nameById = new Map(rows.map((r) => [r.id, r.name]));
      for (const c of validationCases) {
        (c as any).reviewerName = c.reviewerId ? nameById.get(c.reviewerId) ?? null : null;
      }
    }

    return { validationCases, total };
  }

  /**
   * The people a review can be routed to — HEADS only. On this desk the review/approve
   * decision belongs to the heads; validators are the working members (they receive the
   * packet, key it, run assayer clarifications, and hand the report back). Routing lets
   * the few heads split the review queue among themselves. Same rationale as the
   * data-entry team list: the head cannot call the admin-only GET /users.
   */
  async validationTeam(): Promise<Array<{ id: string; name: string; username: string; role: string }>> {
    return this.validationCaseRepository.manager.query(`
      SELECT DISTINCT u.id,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS name,
             u.username, r.name AS role
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = true
        AND r.name IN ('VALIDATION_MANAGER', 'DATA_ENTRY_HEAD')
      ORDER BY name
    `);
  }

  /**
   * The head's team dashboard: who holds what, and how stale it is.
   *
   * One row per desk member (data-entry operators and validators alike) with their open
   * packets, rework bounced back to them, reviews they hold, what they cleared this week,
   * and the age of their oldest open item — the number that tells the head who is stuck
   * versus who has capacity, which is the whole point of assigning work to people.
   */
  async workload(): Promise<{
    members: Array<{
      id: string; name: string; role: string;
      openPackets: number; reworkPackets: number; casesInReview: number;
      handedBackWeek: number; clearedThisWeek: number; oldestOpenDays: number | null;
    }>;
    totals: { unassignedPackets: number; unroutedReviews: number; inReview: number; approved: number; openClarifications: number };
  }> {
    const manager = this.validationCaseRepository.manager;

    const members: any[] = await manager.query(`
      WITH team AS (
        SELECT DISTINCT u.id,
               COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS name,
               r.name AS role
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles r ON r.id = ur.role_id
        WHERE u.is_active = true
          -- The desk's two real roles: heads (assign + work + review) and validators (work).
          AND r.name IN ('DATA_ENTRY_HEAD', 'VALIDATION_MANAGER', 'VALIDATOR')
      ),
      open_docs AS (
        SELECT d.assigned_to_user_id AS uid, COUNT(*) AS open_packets,
               MIN(d.assigned_at) AS oldest_doc,
               COUNT(*) FILTER (WHERE vc.status = 'CORRECTION_REQUIRED') AS rework_packets
        FROM documents d
        LEFT JOIN validation_cases vc
          ON vc.project_branch_id = d.project_branch_id AND vc.is_active = true
        WHERE d.assigned_to_user_id IS NOT NULL
          AND d.data_entry_completed_at IS NULL
          AND d.is_active = true
        GROUP BY d.assigned_to_user_id
      ),
      reviews AS (
        SELECT reviewer_id AS uid,
               COUNT(*) FILTER (WHERE status = 'HUMAN_REVIEW') AS in_review,
               MIN(created_at) FILTER (WHERE status = 'HUMAN_REVIEW') AS oldest_review,
               COUNT(*) FILTER (WHERE status IN ('APPROVED','SUBMITTED') AND reviewed_at >= NOW() - INTERVAL '7 days') AS cleared_week
        FROM validation_cases
        WHERE reviewer_id IS NOT NULL AND is_active = true
        GROUP BY reviewer_id
      ),
      -- Completed work must stay visible: a member who handed everything back showed
      -- all zeros in the open-work columns, indistinguishable from someone who did
      -- nothing. This counts packets they finished in the last 7 days.
      handed_back AS (
        SELECT assigned_to_user_id AS uid, COUNT(*) AS handed_back_week
        FROM documents
        WHERE assigned_to_user_id IS NOT NULL AND is_active = true
          AND data_entry_completed_at >= NOW() - INTERVAL '7 days'
        GROUP BY assigned_to_user_id
      )
      SELECT t.id, t.name, t.role,
             COALESCE(od.open_packets, 0)::int   AS "openPackets",
             COALESCE(od.rework_packets, 0)::int AS "reworkPackets",
             COALESCE(rv.in_review, 0)::int      AS "casesInReview",
             COALESCE(hb.handed_back_week, 0)::int AS "handedBackWeek",
             COALESCE(rv.cleared_week, 0)::int   AS "clearedThisWeek",
             CASE WHEN LEAST(od.oldest_doc, rv.oldest_review) IS NULL THEN NULL
                  ELSE EXTRACT(DAY FROM NOW() - LEAST(od.oldest_doc, rv.oldest_review))::int
             END AS "oldestOpenDays"
      FROM team t
      LEFT JOIN open_docs od ON od.uid = t.id
      LEFT JOIN reviews rv ON rv.uid = t.id
      LEFT JOIN handed_back hb ON hb.uid = t.id
      ORDER BY COALESCE(rv.in_review, 0) + COALESCE(od.open_packets, 0) DESC, t.name
    `);

    const [totals] = await manager.query(`
      SELECT
        (SELECT COUNT(*) FROM documents WHERE type = 'AUDITED_RETURN_PDF' AND is_active = true
           AND assigned_to_user_id IS NULL AND data_entry_completed_at IS NULL
           AND received_at IS NOT NULL)::int AS "unassignedPackets",
        (SELECT COUNT(*) FROM validation_cases WHERE status = 'HUMAN_REVIEW' AND reviewer_id IS NULL AND is_active = true)::int AS "unroutedReviews",
        (SELECT COUNT(*) FROM validation_cases WHERE status = 'HUMAN_REVIEW' AND is_active = true)::int AS "inReview",
        (SELECT COUNT(*) FROM validation_cases WHERE status = 'APPROVED' AND is_active = true)::int AS "approved",
        (SELECT COUNT(*) FROM validation_queries WHERE status IN ('OPEN','RESPONDED'))::int AS "openClarifications"
    `);

    return { members, totals };
  }

  /**
   * The desk's recent activity: who assigned what to whom, who handed what back, what
   * got approved or bounced — across all packets and cases, newest first. The workload
   * strip says how much each member holds; this says what actually HAPPENED, which is
   * the half of "manage the team" the counts can't answer.
   */
  async activity(limit = 20): Promise<Array<{
    at: string; eventType: string; actor: string | null; remarks: string | null;
    branchName: string | null; projectBranchId: string | null;
  }>> {
    const capped = Math.min(100, Math.max(1, Number(limit) || 20));
    return this.validationCaseRepository.manager.query(
      `SELECT ae.occurred_at AS "at", ae.event_type AS "eventType",
              COALESCE(ae.user_display_name,
                       NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                       u.username) AS "actor",
              ae.remarks,
              COALESCE(bd.name, bv.name) AS "branchName",
              COALESCE(d.project_branch_id, vc.project_branch_id) AS "projectBranchId"
         FROM audit_events ae
         LEFT JOIN users u ON u.id = ae.user_id
         LEFT JOIN documents d ON ae.entity_type = 'DOCUMENT' AND d.id = ae.entity_id
         LEFT JOIN project_branches pbd ON pbd.id = d.project_branch_id
         LEFT JOIN branches bd ON bd.id = pbd.branch_id
         LEFT JOIN validation_cases vc ON ae.entity_type = 'VALIDATION' AND vc.id = ae.entity_id
         LEFT JOIN project_branches pbv ON pbv.id = vc.project_branch_id
         LEFT JOIN branches bv ON bv.id = pbv.branch_id
        WHERE ae.entity_type IN ('DOCUMENT', 'VALIDATION')
          AND ae.event_type != 'WORKFLOW_COMMAND_EXECUTED'
        ORDER BY ae.occurred_at DESC
        LIMIT $1`,
      [capped],
    );
  }

  /**
   * The visible audit trail for one unit of work: everything that happened to the case
   * AND to the branch's packets (delegation, hand-back), merged into one timeline. The
   * events were always recorded — this is the first read path desk roles can reach; the
   * global /audit endpoints are admin-only by design and stay that way.
   */
  async trail(id: string): Promise<Array<{
    at: string; eventType: string; actor: string | null;
    previousState: string | null; newState: string | null; remarks: string | null;
  }>> {
    const validationCase = await this.findOne(id);

    return this.validationCaseRepository.manager.query(
      `SELECT ae.occurred_at AS "at", ae.event_type AS "eventType",
              COALESCE(ae.user_display_name,
                       NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
                       u.username) AS "actor",
              ae.previous_state AS "previousState", ae.new_state AS "newState", ae.remarks
         FROM audit_events ae
         LEFT JOIN users u ON u.id = ae.user_id
        WHERE (ae.entity_type = 'VALIDATION' AND ae.entity_id = $1)
           OR (ae.entity_type = 'DOCUMENT' AND ae.entity_id IN (
                 SELECT id FROM documents WHERE project_branch_id = $2))
        ORDER BY ae.occurred_at DESC
        LIMIT 120`,
      [id, validationCase.projectBranchId],
    );
  }

  async assign(id: string, reviewerId: string, userId: string): Promise<ValidationCaseEntity> {
    const validationCase = await this.findOne(id);
    const prevStatus = validationCase.status;

    // The reviewer is a real, active person — an unchecked uuid here becomes a case
    // assigned to nobody, which looks staffed on the board and never moves.
    const [reviewer] = await this.validationCaseRepository.manager.query(
      `SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), username) AS name
         FROM users WHERE id = $1 AND is_active = true`,
      [reviewerId],
    );
    if (!reviewer) {
      throw new BadRequestException('Reviewer must be an existing active user.');
    }

    /**
     * Assignment means two different things depending on where the case is:
     *  - PENDING: the classic pre-work assignment — moves the case to ASSIGNED.
     *  - HUMAN_REVIEW / CORRECTION_REQUIRED: the head routing the REVIEW to a specific
     *    validator. The case is already in the review stage; only the owner changes.
     *    Forcing the status back to ASSIGNED here (the old behaviour) tripped the
     *    transition guard and made review-stage assignment impossible — which is why the
     *    board had no way to say who was validating what.
     */
    const reviewStage =
      prevStatus === ValidationStatus.HUMAN_REVIEW || prevStatus === ValidationStatus.CORRECTION_REQUIRED;

    if (!reviewStage) {
      if (!isValidTransition(VALIDATION_TRANSITIONS, prevStatus, ValidationStatus.ASSIGNED)) {
        throw new BadRequestException(`Invalid Transition: Cannot transition validation case from ${prevStatus} to ASSIGNED.`);
      }
      validationCase.status = ValidationStatus.ASSIGNED;
    }

    validationCase.reviewerId = reviewerId;
    validationCase.updatedBy = userId;

    const saved = await this.validationCaseRepository.save(validationCase);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: reviewStage ? 'VALIDATION_REVIEWER_ASSIGNED' : 'VALIDATION_ASSIGNED',
      entityType: 'VALIDATION',
      entityId: saved.id,
      previousState: prevStatus,
      newState: saved.status,
      userId,
      remarks: `Validation ${reviewStage ? 'review routed' : 'case assigned'} to ${reviewer.name}.`,
      metadata: { reviewerId },
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

    /**
     * A case must not be sent to the client while a question about its evidence is still open.
     * Submitting an audit report to the bank with an unresolved clarification against it is
     * exactly the integrity gap the trail exists to prevent — the answer might change a figure
     * on the report. Blocked on any query that is not RESOLVED; the desk resolves or the assayer
     * answers and the desk resolves, then submission proceeds.
     */
    if (targetStatus === ValidationStatus.SUBMITTED) {
      const unresolved = await this.validationQueryRepository.count({
        where: { validationCaseId: id, status: In([ValidationQueryStatus.OPEN, ValidationQueryStatus.RESPONDED]) },
      });
      if (unresolved > 0) {
        throw new BadRequestException(
          `Cannot submit to the client while ${unresolved} clarification(s) are unresolved. Resolve them first.`,
        );
      }
    }

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

        /**
         * The two outcomes of a review that nobody was ever told about.
         *
         * A case could pass validation, or be sent all the way back to planning with the
         * assessment reopened for re-keying, and the only trace either way was a row in the
         * audit trail. The operator whose queue the rework lands in found out by noticing it.
         *
         * `emitSafe`, not `emit`: this runs inside the workflow command's transaction, and a
         * notification failure must not roll back a completed state transition.
         */
        const branchName = validationCase.projectBranch?.branch?.name ?? 'a branch';

        if (targetStatus === ValidationStatus.APPROVED) {
          this.notificationDispatch.emitSafe({
            type: 'VALIDATION_COMPLETED',
            entityType: 'VALIDATION',
            entityId: saved.id,
            actorUserId: userId,
            dedupeKey: `VALIDATION_COMPLETED:${saved.id}`,
            payload: { validationCaseId: saved.id, branchName },
          });
        } else if (targetStatus === ValidationStatus.CORRECTION_REQUIRED) {
          // RECORD_OWNER is the data-entry operator the packet was delegated to — the one
          // whose queue the rework reappears in. The validation case does not carry them
          // (its own createdBy/updatedBy are the head's and the validator's), so it comes
          // from the delegated document for this branch, which is where the assignment was
          // recorded. Null when no packet was ever delegated; the role fan-out still fires.
          const [row] = await this.validationCaseRepository.manager.query(
            `SELECT assigned_to_user_id AS "ownerUserId"
               FROM documents
              WHERE project_branch_id = $1 AND assigned_to_user_id IS NOT NULL
              ORDER BY assigned_at DESC NULLS LAST
              LIMIT 1`,
            [validationCase.projectBranchId],
          ).catch(() => [] as any[]);

          this.notificationDispatch.emitSafe({
            type: 'VALIDATION_CORRECTION_REQUIRED',
            entityType: 'VALIDATION',
            entityId: saved.id,
            actorUserId: userId,
            ownerUserId: row?.ownerUserId ?? null,
            // Re-work can be demanded more than once on the same case, and each round is a
            // separate thing the operator has to act on.
            dedupeKey: `VALIDATION_CORRECTION_REQUIRED:${saved.id}:${Date.now()}`,
            payload: {
              validationCaseId: saved.id,
              branchName,
              reason: remarks ?? notes ?? 'No reason was given.',
            },
          });
        }

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
