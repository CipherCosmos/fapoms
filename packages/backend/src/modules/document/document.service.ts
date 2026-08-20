import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ValidationService } from '../validation/validation.service';
import { Repository, In } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import {
  EventCategory, DocumentStatus, DocumentType, DispatchMethod, businessTodayDateKey,
  DOCUMENT_TRANSITIONS, canTransitionDocument,
} from '@fapoms/shared';

/** Branch rows returned when the caller names no window. */
const BRANCH_PAGE_DEFAULT = 25;

/**
 * The most branch rows one overview request can return.
 *
 * The branch list used to have no LIMIT at all: it sorted and serialised every active
 * project-branch in the system — 40,087 rows and 17.0 MB of JSON on the 200k book, for a panel
 * that renders twenty-five cards. A ceiling the caller cannot raise is what stops a future
 * `?limit=999999` from quietly restoring exactly the behaviour being removed here.
 */
const BRANCH_PAGE_MAX = 100;

/**
 * Cap on the never-prepared alert list.
 *
 * This is an alert banner, not a worklist — it names branches whose audit is confirmed with no
 * packet prepared at all. Six on the scale book today, but it is derived from a filter, not a
 * fixed set, so it needs its own bound rather than inheriting "however many there happen to be".
 * `totals.neverPrepared` carries the true count so the banner can say so when it is truncated.
 */
const NEVER_PREPARED_MAX = 50;

/** The pseudo-stage the branch panel uses for "confirmed audit, nothing prepared at all". */
const NEVER_PREPARED_STAGE = 'NEVER_PREPARED';

/**
 * Rows returned for the "prepared but not sent" queue. It is ordered by audit date, so the cap
 * keeps the urgent end; `totals.awaitingDispatch` carries the real number beside it.
 */
const AWAITING_DISPATCH_MAX = 100;

export interface CreateDocumentDto {
  assessmentId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  type: DocumentType;
  /** For a generated audit packet: the client batch it was produced from. */
  customerMasterVersionId?: string;
}

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  // ── Data entry desk ───────────────────────────────────────────────────────

  /**
   * The head's distribution queue: returned packets at the desk, with who owns each.
   *
   * Paginated and filtered in SQL, not in the page. The old shape returned every row
   * and let the browser count and slice — fine at fifty packets, unusable at fifty
   * thousand. The packet's LANE is also computed here, joined against the branch's
   * validation case, so "rework" (case bounced back) and "with head" (left the desk)
   * are queryable states rather than client-side inference:
   *   unassigned → nobody owns it;  working → owner typing it up;
   *   rework     → review bounced it back to the owner;
   *   done       → handed back / in review / approved / submitted (left the desk).
   */
  async dataEntryQueue(opts: {
    assignedTo?: string;
    lane?: 'unassigned' | 'working' | 'rework' | 'done';
    search?: string;
    page?: number;
    limit?: number;
  } = {}): Promise<any> {
    const page = Math.max(1, Number(opts.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(opts.limit) || 25));

    const laneExpr = `CASE
      WHEN vc.status = 'CORRECTION_REQUIRED' THEN 'rework'
      WHEN vc.status IN ('HUMAN_REVIEW', 'APPROVED', 'SUBMITTED') THEN 'done'
      WHEN d.assigned_to_user_id IS NULL THEN 'unassigned'
      ELSE 'working'
    END`;

    const base = () => {
      const qb = this.documentRepository
        .createQueryBuilder('d')
        .leftJoin('project_branches', 'pb', 'pb.id = d.project_branch_id')
        .leftJoin('branches', 'b', 'b.id = pb.branch_id')
        .leftJoin('validation_cases', 'vc', 'vc.project_branch_id = d.project_branch_id AND vc.is_active = true')
        .where('d.is_active = true')
        .andWhere('d.type = :type', { type: DocumentType.AUDITED_RETURN_PDF })
        .andWhere('d.status IN (:...statuses)', {
          statuses: [DocumentStatus.RECEIVED, DocumentStatus.SENT_TO_DATA_ENTRY, DocumentStatus.SENT_TO_EXTERNAL_OCR],
        });
      if (opts.assignedTo === 'unassigned') qb.andWhere('d.assigned_to_user_id IS NULL');
      else if (opts.assignedTo) qb.andWhere('d.assigned_to_user_id = :uid', { uid: opts.assignedTo });
      if (opts.search) {
        qb.andWhere('(b.name ILIKE :q OR b.branch_code ILIKE :q OR d.file_name ILIKE :q)', { q: `%${opts.search}%` });
      }
      return qb;
    };

    // Counts per lane over the whole filtered set (minus the lane filter itself), so the
    // lane chips stay truthful whichever lane is open.
    const countRows: Array<{ lane: string; n: string }> = await base()
      .select(`${laneExpr} AS lane`)
      .addSelect('COUNT(*) AS n')
      .groupBy('lane')
      .getRawMany();
    const counts = { unassigned: 0, working: 0, rework: 0, done: 0 };
    for (const r of countRows) (counts as any)[r.lane] = Number(r.n);

    const listQb = base()
      .leftJoin('users', 'u', 'u.id = d.assigned_to_user_id')
      .select([
        'd.id AS id', 'd.file_name AS "fileName"', 'd.status AS status',
        'd.received_at AS "receivedAt"', 'd.sent_to_data_entry_at AS "sentToDataEntryAt"',
        'd.assigned_to_user_id AS "assignedToUserId"', 'd.assigned_at AS "assignedAt"',
        'd.data_entry_completed_at AS "completedAt"',
        'd.project_branch_id AS "projectBranchId"',
        'b.name AS "branchName"', 'b.branch_code AS "branchCode"',
        'vc.status AS "caseStatus"',
        `${laneExpr} AS lane`,
        `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS "assigneeName"`,
      ]);
    if (opts.lane) listQb.andWhere(`${laneExpr} = :lane`, { lane: opts.lane });

    const total = await listQb.clone().getCount();
    const items = await listQb
      .orderBy('d.receivedAt', 'ASC', 'NULLS LAST')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany();

    return { counts, total, page, limit, items };
  }

  /**
   * The people a packet can be delegated to. The head cannot call GET /users —
   * that is admin-only — so without this they had no way to pick an assignee.
   */
  async dataEntryTeam(): Promise<any[]> {
    return this.documentRepository.manager.query(`
      SELECT DISTINCT u.id,
             COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS name,
             u.username, r.name AS role
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = true
        -- Heads also work packets themselves, so they are valid assignees alongside
        -- validators — the desk's working members.
        AND r.name IN ('DESK', 'DESK', 'DESK_OPERATOR')
      ORDER BY name
    `);
  }

  /** Head delegates a returned packet to a team member. */
  async assignForDataEntry(documentId: string, assigneeId: string, actorId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(documentId);
    if (doc.type !== DocumentType.AUDITED_RETURN_PDF) {
      throw new BadRequestException('Only returned audit packets are delegated to data entry.');
    }
    // Captured before the transition below, or the audit row would record the new status
    // as both the previous and the new one.
    const previousStatus = doc.status;

    doc.assignedToUserId = assigneeId;
    doc.assignedAt = new Date();
    doc.assignedBy = actorId;
    doc.dataEntryCompletedAt = null;
    // Advance only from a state the pipeline actually allows it from — in practice RECEIVED,
    // stated through the shared map rather than re-asserted here, so there is one rule about
    // where a packet may move and not two. A packet already past this point keeps its place.
    if (canTransitionDocument(doc.status, DocumentStatus.SENT_TO_DATA_ENTRY)) {
      doc.status = DocumentStatus.SENT_TO_DATA_ENTRY;
      doc.sentToDataEntryAt = doc.sentToDataEntryAt ?? new Date();
    }
    doc.updatedBy = actorId;
    const saved = await this.documentRepository.save(doc);

    /**
     * Chain of custody.
     *
     * These five transitions move an audited return between hands — dispatched to an
     * assayer, received back, delegated to a data-entry member, handed back, sent to an
     * external OCR provider. None of them recorded anything, so the document's own status
     * column was the only evidence of where a packet had been, and it holds one value: the
     * latest. For a firm whose product is audit evidence, who held a packet and when is
     * exactly the question that has to be answerable years later.
     */
    // The remark is read by people (activity feed, case trail) — a uuid answers nothing.
    const [assignee] = await this.documentRepository.manager.query(
      `SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), username) AS name FROM users WHERE id = $1`,
      [assigneeId],
    ).catch(() => [] as any[]);

    await this.auditService.recordEventSafe({
      category: EventCategory.WORKFLOW,
      eventType: 'DOCUMENT_DELEGATED_TO_DATA_ENTRY',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      previousState: previousStatus,
      newState: saved.status,
      userId: actorId,
      remarks: `Packet ${saved.fileName} delegated to ${assignee?.name ?? assigneeId}.`,
      metadata: { assigneeId, projectBranchId: doc.projectBranchId ?? null },
    });

    // The assignee learns of the delegation from the system rather than from the head
    // walking over. Re-delegating the same packet to someone else is a genuinely new
    // hand-off, so the assignee is part of the dedupe key.
    this.notificationDispatch.emitSafe({
      type: 'DATA_ENTRY_ASSIGNED',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      actorUserId: actorId,
      ownerUserId: assigneeId,
      dedupeKey: `DATA_ENTRY_ASSIGNED:${saved.id}:${assigneeId}`,
      payload: {
        documentName: saved.fileName,
        branchName: doc.assessment?.branch?.name ?? 'a branch',
      },
    });

    // Opens the case (at PENDING) as soon as work starts, not only at hand-back,
    // so the member has somewhere to raise a clarification while still processing.
    if (doc.projectBranchId) {
      try {
        await this.validationService.getOrCreateForBranch(doc.projectBranchId, doc.assessmentId ?? null, actorId);
      } catch (e) {
        this.logger.warn(`Could not open validation case for branch ${doc.projectBranchId}: ${(e as Error).message}`);
      }
    }
    return saved;
  }

  /**
   * Member hands the processed packet back to the head. This is the moment the
   * two previously separate worlds join: the returned document and its
   * validation case. Before this, nothing ever advanced a case past PENDING, so
   * the head's review queue and the data entry queue had no connection at all.
   */
  async completeDataEntry(documentId: string, actorId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(documentId);
    if (!doc.assignedToUserId) {
      throw new BadRequestException('This packet has not been delegated to anyone.');
    }
    doc.dataEntryCompletedAt = new Date();
    doc.updatedBy = actorId;
    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'DOCUMENT_DATA_ENTRY_COMPLETED',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      userId: actorId,
      remarks: `Packet ${saved.fileName} handed back by user ${doc.assignedToUserId}.`,
      metadata: { assignedToUserId: doc.assignedToUserId, projectBranchId: doc.projectBranchId ?? null },
    });

    // Emitted before the validation advance below, and independently of whether it succeeds:
    // the hand-back itself is what the head needs to hear about, and tying the alert to the
    // validation case would silence it in exactly the case where the case did not move.
    this.notificationDispatch.emitSafe({
      type: 'DATA_ENTRY_COMPLETED',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      actorUserId: actorId,
      dedupeKey: `DATA_ENTRY_COMPLETED:${saved.id}:${saved.dataEntryCompletedAt!.toISOString()}`,
      payload: {
        userName: await this.resolveUserName(actorId),
        branchName: doc.assessment?.branch?.name ?? 'a branch',
      },
    });

    if (doc.projectBranchId) {
      try {
        await this.validationService.getOrAdvanceForHandBack(doc.projectBranchId, doc.assessmentId ?? null, actorId);
        (saved as any).validationAdvanced = true;
      } catch (e) {
        /**
         * Still not fatal — losing the operator's completed work over a validation hiccup
         * would be worse. But it is no longer *silent*: this used to log a warning and return
         * HTTP 200, so a hand-back that never reached the head's review queue was
         * indistinguishable from one that did. The packet then sat in "being worked" forever
         * while the operator believed they had passed it on.
         *
         * The head is told either way — DATA_ENTRY_COMPLETED is emitted above, outside this
         * block — so the operator is no longer the relay. The flag now only warns that the
         * packet is missing from the *review queue* and needs re-queuing, which is a thing
         * the head fixes, not the operator.
         */
        this.logger.error(
          `Hand-back saved for branch ${doc.projectBranchId} but its validation case did not advance to review: ${(e as Error).message}`,
        );
        (saved as any).validationAdvanced = false;
        (saved as any).validationWarning =
          'Your work was saved and your head has been notified, but this packet did not reach the review queue — your head will need to re-queue it.';
      }
    }
    return saved;
  }

  /**
   * Notification bodies name the person, not their uuid — a "user 3f2a… finished data entry"
   * line tells the head nothing they can act on. Same COALESCE shape the queue views above
   * use, so a user with no first/last name still resolves to their username.
   */
  private async resolveUserName(userId: string | null | undefined): Promise<string> {
    if (!userId) return 'A team member';
    const [row] = await this.documentRepository.manager.query(
      `SELECT COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS name
         FROM users u WHERE u.id = $1`,
      [userId],
    );
    return row?.name ?? 'A team member';
  }

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepository: Repository<AssessmentEntity>,
    @InjectRepository(ProjectBranchEntity)
    private readonly projectBranchRepository: Repository<ProjectBranchEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly notificationService: NotificationService,
    private readonly notificationDispatch: NotificationDispatchService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly validationService: ValidationService,
  ) {}

  async create(dto: CreateDocumentDto, userId: string): Promise<DocumentEntity> {
    let assessment = await this.assessmentRepository.findOne({
      where: { id: dto.assessmentId, isActive: true },
    }).catch(() => null);

    // The packet is keyed to a project branch so the data entry desk can open and
    // advance it by branch. Resolve it whether we were given an assessment, a branch
    // id, or an assignment id, and carry it onto the stored document.
    let pb: any = null;

    if (!assessment) {
      pb = await this.projectBranchRepository.findOne({ where: { id: dto.assessmentId } }).catch(() => null);
      if (!pb) {
        const asn = await this.assignmentRepository.findOne({ where: { id: dto.assessmentId } }).catch(() => null);
        if (asn?.projectBranchId) {
          pb = await this.projectBranchRepository.findOne({ where: { id: asn.projectBranchId } }).catch(() => null);
        }
      }
      if (pb) {
        assessment = await this.assessmentRepository.findOne({
          where: { projectId: pb.projectId, branchId: pb.branchId, isActive: true },
        }).catch(() => null);
        if (!assessment) {
          assessment = await this.assessmentRepository.save(
            this.assessmentRepository.create({
              projectId: pb.projectId,
              branchId: pb.branchId,
              createdBy: userId,
              updatedBy: userId,
            }),
          );
        }
      }
    }

    if (!assessment) {
      throw new NotFoundException(`Assessment, ProjectBranch or Assignment ${dto.assessmentId} not found.`);
    }

    if (!pb) {
      pb = await this.projectBranchRepository
        .findOne({ where: { projectId: assessment.projectId, branchId: assessment.branchId } })
        .catch(() => null);
    }

    const doc = this.documentRepository.create({
      assessmentId: assessment.id,
      projectBranchId: pb?.id ?? null,
      fileName: dto.fileName,
      filePath: dto.filePath,
      fileSize: dto.fileSize,
      mimeType: dto.mimeType ?? null,
      type: dto.type,
      customerMasterVersionId: dto.customerMasterVersionId ?? null,
      status: DocumentStatus.UPLOADED,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'DOCUMENT_UPLOADED',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      userId,
      remarks: `Uploaded document ${dto.fileName} for assessment.`,
    });

    try {
      this.eventPublisher.publish('document:uploaded', {
        eventType: 'document:uploaded',
        documentId: saved.id,
        assessmentId: saved.assessmentId,
        fileName: saved.fileName,
        fileSize: saved.fileSize,
        type: saved.type,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish document:uploaded event:', err);
    }

    // Spec §8.1: uploading the pre-field PDF puts the assessment at READY_FOR_DISPATCH.
    return saved;
  }

  async findOne(id: string): Promise<DocumentEntity> {
    const doc = await this.documentRepository.findOne({
      where: { id, isActive: true },
      relations: ['assessment', 'assessment.branch', 'assessment.project'],
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found.`);
    }
    return doc;
  }

  /**
   * Move a packet one step along the pipeline.
   *
   * This wrote whatever it was handed. Every other lifecycle in the system is guarded by a transition map in
   * `@fapoms/shared`; documents were the exception, so a finished packet could be sent back to
   * UPLOADED and would reappear in the awaiting-dispatch queue and the "paperwork never sent"
   * banner, and staff would re-send work that was already delivered. See DOCUMENT_TRANSITIONS
   * for the shape of the journey and why UPLOADED has three exits.
   *
   * Re-stating the status a packet already holds is a no-op rather than an error: the callers
   * below are retried (the dispatch worker, the receive path called from a `.catch(() => {})`),
   * and a retry that lands on the state it was aiming for has succeeded, not failed.
   */
  async updateStatus(id: string, status: DocumentStatus, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    const prevStatus = doc.status;

    if (prevStatus === status) return doc;
    if (!canTransitionDocument(prevStatus, status)) {
      throw new BadRequestException(
        `A document at ${prevStatus} cannot move to ${status}. Paperwork only moves forward: ` +
        `${(DOCUMENT_TRANSITIONS[prevStatus] ?? []).join(', ') || 'nothing follows this state'}.`,
      );
    }

    doc.status = status;
    doc.updatedBy = userId;

    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: `DOCUMENT_${status}`,
      entityType: 'DOCUMENT',
      entityId: saved.id,
      previousState: prevStatus,
      newState: status,
      userId,
      remarks: `Transitioned document ${doc.fileName} to ${status}.`,
    });

    try {
      this.eventPublisher.publish('document:status-changed', {
        eventType: 'document:status-changed',
        documentId: saved.id,
        assessmentId: saved.assessmentId,
        fileName: saved.fileName,
        previousStatus: prevStatus,
        newStatus: status,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish document:status-changed event:', err);
    }

    return saved;
  }

  /**
   * Read-only lookup of a branch's documents, resolved via its Assessment (documents hang off
   * the Assessment, not the ProjectBranch).
   *
   * This used to have two side effects that made it lie about reality: it created an
   * Assessment row when none existed, and — when the branch had no documents — it fabricated
   * a stub PDF ("FAPOMS PRE-AUDIT CUSTOMER MASTER REPORT"), wrote it to storage, and inserted
   * it already marked DISPATCHED. So merely opening the screen manufactured a document that
   * looked like a real dispatched client file and was never dispatched to anyone.
   *
   * A GET must not mutate. Pre-field PDFs now only enter the system through a real upload
   * (ops downloads from the external OCR application and uploads it here), so an empty list
   * correctly means "no paperwork has arrived for this branch yet".
   */
  /**
   * The document control console: every document with the branch it belongs to,
   * its full transport trail, and the queues that need action.
   *
   * The management page previously listed file name, type, status and an upload
   * date with no indication of *which branch* a document was for, and showed none
   * of the dispatched/received/sent-to-OCR timestamps the row already carries — so
   * "where is branch X's paperwork right now" could not be answered from it.
   */
  async operationsOverview(filters: {
    projectId?: string; status?: string; type?: string;
    /** Window over the branch list only — the other arrays in this payload are bounded by their own filters. */
    page?: number | string; limit?: number | string;
    /** Server-side branch search. 40k branches is past the point where "scroll to find one" is a feature. */
    search?: string;
    /** A `DocumentStatus` the branch must have a document sitting at, or `NEVER_PREPARED`. */
    stage?: string;
  } = {}): Promise<any> {
    /**
     * The filter every document query below shares, so the page, its counts and the queues agree.
     *
     * `search` and `stage` move into SQL with the window. They cannot stay in the browser: a
     * client-side filter over one page searches the page, not the book — the same reason the
     * branch list below pushed them down. `includeStage` is off for the pipeline counts, which
     * must describe the whole backlog rather than the slice currently selected.
     */
    const buildDocWhere = (params: any[], opts: { includeStage?: boolean; includeSearch?: boolean } = {}): string => {
      const clauses = ['d.is_active = true'];
      if (filters.projectId) { params.push(filters.projectId); clauses.push(`a.project_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); clauses.push(`d.status = $${params.length}`); }
      if (filters.type) { params.push(filters.type); clauses.push(`d.type = $${params.length}`); }
      const search = (filters.search ?? '').trim();
      if (opts.includeSearch !== false && search) {
        params.push(`%${search}%`);
        const q = `$${params.length}`;
        // The same fields the panel's own search box matched on, so moving it to the server
        // changes where it runs, not what it finds.
        clauses.push(`(d.file_name ILIKE ${q} OR b.name ILIKE ${q} OR b.branch_code ILIKE ${q}
                       OR p.name ILIKE ${q} OR c.name ILIKE ${q})`);
      }
      const stage = (filters.stage ?? '').trim();
      if (opts.includeStage !== false && stage && stage !== NEVER_PREPARED_STAGE) {
        params.push(stage);
        clauses.push(`d.status = $${params.length}`);
      }
      return clauses.join(' AND ');
    };

    const DOC_JOINS = `
         FROM documents d
         LEFT JOIN assessments a  ON a.id = d.assessment_id
         LEFT JOIN branches b     ON b.id = a.branch_id
         LEFT JOIN projects p     ON p.id = a.project_id
         LEFT JOIN clients c      ON c.id = p.client_id`;

    const docPage = Math.max(1, Math.trunc(Number(filters.page)) || 1);
    const docLimit = Math.min(BRANCH_PAGE_MAX, Math.max(1, Number(filters.limit) || BRANCH_PAGE_DEFAULT));

    const docParams: any[] = [];
    const docWhere = buildDocWhere(docParams);
    const rows = await this.documentRepository.manager.query(
      `SELECT d.id, d.file_name, d.file_size, d.type, d.status, d.doc_version,
              d.created_at, d.dispatched_at, d.dispatch_method, d.dispatched_by,
              d.received_at, d.sent_to_data_entry_at, d.sent_to_external_ocr_at,
              d.assessment_id,
              b.name AS branch_name, b.branch_code,
              p.name AS project_name, p.project_number,
              c.name AS client_name,
              pb.id AS project_branch_id, pb.scheduled_date,
              u.display_name AS dispatched_by_name
         FROM documents d
         LEFT JOIN assessments a  ON a.id = d.assessment_id
         LEFT JOIN branches b     ON b.id = a.branch_id
         LEFT JOIN projects p     ON p.id = a.project_id
         LEFT JOIN clients c      ON c.id = p.client_id
         LEFT JOIN project_branches pb ON pb.project_id = a.project_id AND pb.branch_id = a.branch_id
         LEFT JOIN users u        ON u.id = d.dispatched_by
        WHERE ${docWhere}
        -- created_at alone ties on bulk-imported batches, and an unbroken tie under
        -- LIMIT/OFFSET lets rows swap between pages; id breaks it.
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${docLimit} OFFSET ${(docPage - 1) * docLimit}`,
      docParams,
    );

    const documents = rows.map((r: any) => ({
      id: r.id,
      fileName: r.file_name,
      fileSize: Number(r.file_size ?? 0),
      type: r.type,
      status: r.status,
      version: r.doc_version,
      createdAt: r.created_at,
      projectBranchId: r.project_branch_id,
      assessmentId: r.assessment_id,
      branchName: r.branch_name,
      branchCode: r.branch_code,
      projectName: r.project_name,
      projectNumber: r.project_number,
      clientName: r.client_name,
      scheduledDate: r.scheduled_date,
      // The journey, in the order it happens — this is what the console was missing.
      trail: {
        uploadedAt: r.created_at,
        dispatchedAt: r.dispatched_at,
        dispatchMethod: r.dispatch_method,
        dispatchedByName: r.dispatched_by_name,
        receivedAt: r.received_at,
        sentToDataEntryAt: r.sent_to_data_entry_at,
        sentToExternalOcrAt: r.sent_to_external_ocr_at,
      },
    }));

    /**
     * Pipeline counts, in lifecycle order rather than alphabetical, so the shape of the backlog
     * is readable at a glance.
     *
     * One grouped pass over the whole set, NOT eight `.filter()` passes over the page. Counted
     * without the stage filter on purpose: these numbers are the chips a person clicks to
     * choose a stage, so counting only the selected stage would leave every other chip at zero
     * the moment one was picked.
     */
    const docCountParams: any[] = [];
    const docCountWhere = buildDocWhere(docCountParams, { includeStage: false });
    const stageCountRows: Array<{ status: string; n: string }> = await this.documentRepository.manager.query(
      `SELECT d.status, COUNT(*)::int AS n ${DOC_JOINS} WHERE ${docCountWhere} GROUP BY d.status`,
      docCountParams,
    );
    const countByStage = new Map(stageCountRows.map((r) => [r.status, Number(r.n)]));
    const documentsTotal = stageCountRows.reduce((sum, r) => sum + Number(r.n), 0);

    const stageOrder = [
      DocumentStatus.UPLOADED, DocumentStatus.DISPATCHED, DocumentStatus.RECEIVED,
      DocumentStatus.SENT_TO_DATA_ENTRY, DocumentStatus.SENT_TO_EXTERNAL_OCR,
      DocumentStatus.EXCEL_GENERATED, DocumentStatus.PROCESSED, DocumentStatus.COMPLETED,
    ];
    const pipeline = stageOrder.map((stage) => ({ stage, count: countByStage.get(stage) ?? 0 }));

    /** Outstanding pre-audit packets, counted over the whole set rather than the page. */
    const typeCountRows: Array<{ status: string; type: string; n: string }> = await this.documentRepository.manager.query(
      `SELECT d.status, d.type, COUNT(*)::int AS n ${DOC_JOINS} WHERE ${docCountWhere} GROUP BY d.status, d.type`,
      [...docCountParams],
    );
    const outstandingReturns = typeCountRows
      .filter((r) => r.status === DocumentStatus.DISPATCHED && r.type === DocumentType.PRE_FIELD_AUDIT_PDF)
      .reduce((sum, r) => sum + Number(r.n), 0);

    // Paperwork prepared but not released, for a branch whose audit is already
    // scheduled — the assayer cannot start without it, so this is the queue that
    // actually blocks field work.
    const today = businessTodayDateKey();

    /**
     * Its own query, not a filter over the page.
     *
     * This is a queue, ordered by urgency — it has to see the whole book, or the most urgent
     * unsent packet drops off simply because its row fell on page two. Bounded like the other
     * lists here, with the true count returned beside it.
     */
    const awaitParams: any[] = [];
    const awaitWhere = buildDocWhere(awaitParams, { includeStage: false, includeSearch: false });
    awaitParams.push(DocumentStatus.UPLOADED);
    const awaitStatusIdx = awaitParams.length;
    const visibleTypes = DocumentService.ASSAYER_VISIBLE_TYPES;
    awaitParams.push(visibleTypes);
    const awaitTypesIdx = awaitParams.length;
    const awaitRows = await this.documentRepository.manager.query(
      `SELECT d.id, d.file_name, d.file_size, d.type, d.status, d.doc_version, d.created_at,
              b.name AS branch_name, b.branch_code, p.name AS project_name, p.project_number,
              c.name AS client_name, pb.id AS project_branch_id, pb.scheduled_date,
              COUNT(*) OVER() AS total_matching
         ${DOC_JOINS}
         LEFT JOIN project_branches pb ON pb.project_id = a.project_id AND pb.branch_id = a.branch_id
        WHERE ${awaitWhere} AND d.status = $${awaitStatusIdx} AND d.type = ANY($${awaitTypesIdx})
        ORDER BY pb.scheduled_date ASC NULLS LAST, d.created_at ASC
        LIMIT ${AWAITING_DISPATCH_MAX}`,
      awaitParams,
    );
    const awaitingDispatchTotal = Number(awaitRows?.[0]?.total_matching ?? 0);
    const awaitingDispatch = awaitRows.map((r: any) => ({
      id: r.id,
      fileName: r.file_name,
      fileSize: Number(r.file_size ?? 0),
      type: r.type,
      status: r.status,
      version: r.doc_version,
      createdAt: r.created_at,
      branchName: r.branch_name,
      branchCode: r.branch_code,
      projectName: r.project_name,
      projectNumber: r.project_number,
      clientName: r.client_name,
      projectBranchId: r.project_branch_id,
      scheduledDate: r.scheduled_date,
      // Negative = the audit date has already passed with paperwork unsent.
      daysUntilAudit: r.scheduled_date
        ? Math.round((new Date(r.scheduled_date).getTime() - new Date(today).getTime()) / 86400000)
        : null,
    }));

    // ── Branch-grouped view ──────────────────────────────────────────────
    //
    // The flat `documents` list above is one row per file, so a branch with two
    // documents (say a pre-audit PDF plus its returned paperwork) shows that
    // branch's name twice with nothing to indicate they're the same branch at two
    // different stages — reading as a duplicate rather than two files for one
    // branch. This groups by branch instead, and — critically — includes branches
    // that have *no* documents at all, which the flat list could never show.
    //
    // The list is a WINDOW, not the table. It used to have no LIMIT: every active
    // project-branch was sorted and serialised on every load — 40,087 rows and 17.0 MB of JSON
    // on the 200k book — for a panel that shows twenty-five cards. Phase 5 paginated the billing
    // and documents *lists* and missed this one.
    //
    // Search and the stage filter move into SQL with it. They cannot stay in the browser: a
    // client-side filter over one page searches the page, not the book, so typing a branch name
    // would silently "find" nothing for 40,062 of the 40,087 branches.
    const page = Math.max(1, Math.trunc(Number(filters.page)) || 1);
    const limit = Math.min(BRANCH_PAGE_MAX, Math.max(1, Number(filters.limit) || BRANCH_PAGE_DEFAULT));

    /**
     * "Audit confirmed, nothing prepared at all" as a SQL predicate.
     *
     * Written once and used three ways — to filter the list, to flag each row, and to build the
     * alert list — because these three used to be one JS `.filter()` over the whole table and
     * must not drift now that they are separate queries. Takes the params array so the branch
     * type stays a bound parameter rather than an interpolated string.
     */
    const neverPreparedSql = (params: any[]): string => {
      params.push(DocumentType.PRE_FIELD_AUDIT_PDF);
      return `pb.scheduled_date IS NOT NULL
              AND pb.status IN ('ASSIGNMENT_CONFIRMED', 'SCHEDULED')
              AND NOT EXISTS (SELECT 1 FROM documents d2
                                JOIN assessments a2 ON a2.id = d2.assessment_id
                               WHERE d2.is_active = true AND d2.type = $${params.length}
                                 AND a2.project_id = pb.project_id AND a2.branch_id = pb.branch_id)`;
    };

    /** The filter every branch query below shares, so the page, its count and the flag agree. */
    const buildBranchWhere = (params: any[]): string => {
      const clauses = ['pb.is_active = true'];
      if (filters.projectId) { params.push(filters.projectId); clauses.push(`pb.project_id = $${params.length}`); }
      const search = (filters.search ?? '').trim();
      if (search) {
        params.push(`%${search}%`);
        const q = `$${params.length}`;
        // The same four fields the panel's own search box used to match on, so moving it to the
        // server changes where it runs, not what it finds.
        clauses.push(`(b.name ILIKE ${q} OR b.branch_code ILIKE ${q} OR p.name ILIKE ${q} OR c.name ILIKE ${q})`);
      }
      const stage = (filters.stage ?? '').trim();
      if (stage === NEVER_PREPARED_STAGE) {
        clauses.push(`(${neverPreparedSql(params)})`);
      } else if (stage) {
        params.push(stage);
        clauses.push(`EXISTS (SELECT 1 FROM documents d2
                                JOIN assessments a2 ON a2.id = d2.assessment_id
                               WHERE d2.is_active = true AND d2.status = $${params.length}
                                 AND a2.project_id = pb.project_id AND a2.branch_id = pb.branch_id)`);
      }
      return clauses.join(' AND ');
    };

    // `b.name` alone is not a stable sort here: 40,087 active branches share only 20,086 distinct
    // names, so almost every name is a two-row tie. Under LIMIT/OFFSET an unbroken tie lets rows
    // swap between pages — an operator paging through would see one branch twice and never see
    // the other. `pb.id` breaks it.
    const BRANCH_ORDER = 'ORDER BY b.name, pb.id';
    const BRANCH_FROM = `FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
         JOIN projects p ON p.id = pb.project_id
         LEFT JOIN clients c ON c.id = p.client_id`;

    const listParams: any[] = [];
    const listWhere = buildBranchWhere(listParams);
    const listFlag = neverPreparedSql(listParams);
    listParams.push(limit, (page - 1) * limit);

    const countParams: any[] = [];
    const countWhere = buildBranchWhere(countParams);

    const gapParams: any[] = [];
    // Deliberately NOT filtered by `search` or `stage`: this banner answers "what has no paperwork
    // at all", which is a property of the book, not of whatever the operator has typed. It tracked
    // the whole set before pagination and still does. `projectId` does apply — that scopes the
    // whole page, not just the list.
    if (filters.projectId) gapParams.push(filters.projectId);
    const gapWhere = filters.projectId ? `pb.is_active = true AND pb.project_id = $1` : 'pb.is_active = true';

    const [branchRows, countRows, gapRows] = await Promise.all([
      this.documentRepository.manager.query(
        `SELECT pb.id AS project_branch_id, pb.scheduled_date,
                b.name AS branch_name, b.branch_code,
                p.name AS project_name,
                c.name AS client_name,
                (${listFlag}) AS never_prepared
           ${BRANCH_FROM}
          WHERE ${listWhere}
          ${BRANCH_ORDER}
          LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams,
      ),
      this.documentRepository.manager.query(
        `SELECT COUNT(*)::int AS n ${BRANCH_FROM} WHERE ${countWhere}`,
        countParams,
      ),
      this.documentRepository.manager.query(
        `SELECT pb.id AS project_branch_id, pb.scheduled_date,
                b.name AS branch_name, b.branch_code,
                p.name AS project_name,
                c.name AS client_name,
                true AS never_prepared,
                COUNT(*) OVER() AS gap_total
           ${BRANCH_FROM}
          WHERE ${gapWhere} AND (${neverPreparedSql(gapParams)})
          ORDER BY pb.scheduled_date ASC, pb.id
          LIMIT ${NEVER_PREPARED_MAX}`,
        gapParams,
      ),
    ]);

    const branchTotal = Number(countRows?.[0]?.n ?? 0);

    const docsByBranch = new Map<string, any[]>();
    for (const d of documents) {
      if (!d.projectBranchId) continue;
      if (!docsByBranch.has(d.projectBranchId)) docsByBranch.set(d.projectBranchId, []);
      docsByBranch.get(d.projectBranchId)!.push(d);
    }

    /**
     * One branch card.
     *
     * The projection stops here on purpose. `branchId`, `projectId`, `projectNumber`,
     * `branchStatus` and `assessmentStatus` were selected and serialised for all 40,087 rows and
     * no consumer reads any of them — `assessmentStatus` was the only reason the query joined
     * `assessments` (200k rows) at all, and that join is now gone. `branchStatus` still exists,
     * as the SQL predicate above, which is the only place it was ever used.
     */
    const toBranchGroup = (r: any) => {
      const docs = docsByBranch.get(r.project_branch_id) ?? [];
      const documentsByType: Record<string, any[]> = {};
      for (const d of docs) {
        (documentsByType[d.type] ??= []).push(d);
      }
      return {
        projectBranchId: r.project_branch_id,
        branchName: r.branch_name,
        branchCode: r.branch_code,
        projectName: r.project_name,
        clientName: r.client_name,
        scheduledDate: r.scheduled_date,
        daysUntilAudit: r.scheduled_date
          ? Math.round((new Date(r.scheduled_date).getTime() - new Date(today).getTime()) / 86400000)
          : null,
        // Carried per row so the panel can flag a gap without holding the whole gap list — which
        // is what `neverPrepared.some(...)` in the browser used to require.
        neverPrepared: r.never_prepared === true,
        documentCount: docs.length,
        documentsByType,
      };
    };

    const branches = branchRows.map(toBranchGroup);

    // An assayer is confirmed and a date is set, but the packet that they need to
    // do the audit was never even created — worse than "prepared but not sent",
    // this is "not prepared at all". Invisible to `awaitingDispatch` above because
    // that only looks at documents that already exist.
    const neverPrepared = gapRows.map(toBranchGroup);
    const neverPreparedTotal = Number(gapRows?.[0]?.gap_total ?? 0);

    return {
      documents,
      pipeline,
      branches,
      /** The window `branches` was cut from. The controller turns this into `meta.pagination`. */
      branchPagination: { page, limit, total: branchTotal },
      /** The window `documents` was cut from — `documents.length` is one page, never the total. */
      documentPagination: { page: docPage, limit: docLimit, total: documentsTotal },
      totals: {
        // Every figure here counts the whole set. They used to count whatever happened to be in
        // the `documents` array, which was the entire table — correct only for as long as the
        // page shipped all of it.
        total: documentsTotal,
        awaitingDispatch: awaitingDispatchTotal,
        // The true count, not `neverPrepared.length` — that list is capped at NEVER_PREPARED_MAX.
        neverPrepared: neverPreparedTotal,
        // Sent to the field but the completed paperwork has not come back.
        outstandingReturns,
        inDataEntry: countByStage.get(DocumentStatus.SENT_TO_DATA_ENTRY) ?? 0,
        completed: countByStage.get(DocumentStatus.COMPLETED) ?? 0,
      },
      awaitingDispatch,
      neverPrepared,
      // Audit already due (or overdue) with nothing dispatched — the urgent subset.
      blockingFieldWork: awaitingDispatch.filter((d: any) => d.daysUntilAudit !== null && d.daysUntilAudit <= 1),
    };
  }

  /**
   * Matches an incoming batch of generated PDFs to the branches scheduled for an
   * audit date, using the filename.
   *
   * The external application returns one PDF per branch for the whole day's run,
   * so they arrive as a folder of ~10 files at once. Uploading them one branch at
   * a time means picking the right branch ten times from a list — the step most
   * likely to be got wrong, and the one that silently sends a branch the wrong
   * customers' paperwork.
   *
   * Matching is deliberately conservative: a file is only auto-assigned when it
   * matches exactly one scheduled branch. Anything ambiguous or unrecognised is
   * returned for a human to place, never guessed at.
   */
  async matchPdfsToBranches(
    projectId: string,
    auditDate: string,
    fileNames: string[],
  ): Promise<{
    matches: Array<{ fileName: string; projectBranchId: string; branchName: string; branchCode: string | null; matchedOn: 'CODE' | 'NAME' }>;
    unmatched: Array<{ fileName: string; reason: string }>;
    branchesWithoutFile: Array<{ projectBranchId: string; branchName: string; branchCode: string | null }>;
  }> {
    const branches: Array<{ project_branch_id: string; branch_name: string; branch_code: string | null }> =
      await this.documentRepository.manager.query(
        `SELECT pb.id AS project_branch_id, b.name AS branch_name, b.branch_code
           FROM project_branches pb
           JOIN branches b ON b.id = pb.branch_id
          WHERE pb.project_id = $1 AND pb.is_active = true AND pb.scheduled_date = $2`,
        [projectId, auditDate],
      );

    // Strip punctuation so "BR-0016", "br0016" and "BR_0016" all compare equal.
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

    const matches: any[] = [];
    const unmatched: Array<{ fileName: string; reason: string }> = [];
    const claimed = new Set<string>();

    for (const fileName of fileNames) {
      const haystack = norm(fileName);

      // Branch code first: it is the unambiguous identifier the client and the
      // external application both carry.
      let candidates = branches.filter((b) => b.branch_code && haystack.includes(norm(b.branch_code)));
      let matchedOn: 'CODE' | 'NAME' = 'CODE';

      if (candidates.length === 0) {
        // Fall back to the branch name, matched on its individual words rather
        // than the whole string: a real filename usually carries only the
        // distinctive part ("Yerwada 20-08.pdf"), not the full registered name
        // ("Pune Yerwada Branch"). "Branch" itself is dropped — it appears in
        // nearly every name and would match everything.
        //
        // A shared word like "Main" will match several branches, which is exactly
        // the ambiguity the caller below refuses to resolve by guessing.
        candidates = branches.filter((b) =>
          b.branch_name
            .split(/\s+/)
            .map((w) => norm(w))
            .filter((w) => w.length >= 4 && w !== 'branch')
            .some((w) => haystack.includes(w)),
        );
        matchedOn = 'NAME';
      }

      if (candidates.length === 0) {
        unmatched.push({ fileName, reason: 'No scheduled branch matches this filename.' });
        continue;
      }
      if (candidates.length > 1) {
        unmatched.push({
          fileName,
          reason: `Matches ${candidates.length} branches (${candidates.map((c) => c.branch_name).join(', ')}) — assign manually.`,
        });
        continue;
      }

      const branch = candidates[0];
      if (claimed.has(branch.project_branch_id)) {
        unmatched.push({ fileName, reason: `Another file in this upload already matched ${branch.branch_name}.` });
        continue;
      }
      claimed.add(branch.project_branch_id);
      matches.push({
        fileName,
        projectBranchId: branch.project_branch_id,
        branchName: branch.branch_name,
        branchCode: branch.branch_code,
        matchedOn,
      });
    }

    return {
      matches,
      unmatched,
      // Scheduled branches this upload did not cover — the other half of "is the
      // day's set complete?".
      branchesWithoutFile: branches
        .filter((b) => !claimed.has(b.project_branch_id))
        .map((b) => ({ projectBranchId: b.project_branch_id, branchName: b.branch_name, branchCode: b.branch_code })),
    };
  }

  /**
   * Dispatches many documents in one operation, reporting per-document outcomes.
   * The console previously offered only one-at-a-time dispatch, which does not
   * match how a day's paperwork is actually released.
   */
  async dispatchMany(documentIds: string[], userId: string): Promise<{
    dispatched: string[];
    failed: Array<{ documentId: string; reason: string }>;
  }> {
    const dispatched: string[] = [];
    const failed: Array<{ documentId: string; reason: string }> = [];
    for (const id of documentIds) {
      try {
        await this.dispatchDocument(id, userId, DispatchMethod.MANUAL);
        dispatched.push(id);
      } catch (err) {
        failed.push({ documentId: id, reason: (err as Error).message });
      }
    }
    return { dispatched, failed };
  }

  /**
   * Document types the assayer is ever allowed to receive. Everything else
   * (branch lists, customer master extracts, generated Excel, final reports) is
   * internal and must not appear on a field device even once dispatched.
   */
  private static readonly ASSAYER_VISIBLE_TYPES = [
    // Only the branch's own generated audit packet. CUSTOMER_MASTER_DATA is
    // deliberately excluded: the client's master file is a single batch covering
    // *every* branch scheduled for that audit date, so dispatching it to one
    // branch's assayer would hand them other branches' customer records.
    DocumentType.PRE_FIELD_AUDIT_PDF,
  ];

  /** A document has reached the assayer only once it has actually been dispatched. */
  private static readonly DISPATCHED_STATUSES = [
    DocumentStatus.DISPATCHED,
    DocumentStatus.RECEIVED,
    DocumentStatus.SENT_TO_DATA_ENTRY,
    DocumentStatus.SENT_TO_EXTERNAL_OCR,
    DocumentStatus.EXCEL_GENERATED,
    DocumentStatus.PROCESSED,
    DocumentStatus.COMPLETED,
  ];

  /**
   * What the assayer may see for a branch, plus why — so the app can distinguish
   * "nothing prepared yet", "prepared but not sent to you", and "ready to download".
   *
   * The mobile app previously listed everything `findByProjectBranch` returned,
   * which included documents still sitting in UPLOADED. The assayer could open
   * paperwork before operations had released it, and the app's own "nothing has
   * been dispatched yet" empty state was unreachable because undispatched
   * documents counted as results.
   */
  async findDispatchedForAssayer(projectBranchId: string): Promise<{
    documents: DocumentEntity[];
    readiness: {
      state: 'READY' | 'PREPARING' | 'NONE';
      dispatchedCount: number;
      awaitingDispatchCount: number;
      message: string;
      lastDispatchedAt: Date | null;
    };
  }> {
    const all = await this.findByProjectBranch(projectBranchId);
    const relevant = all.filter((d) => DocumentService.ASSAYER_VISIBLE_TYPES.includes(d.type));

    const documents = relevant.filter((d) => DocumentService.DISPATCHED_STATUSES.includes(d.status));
    const awaiting = relevant.filter((d) => d.status === DocumentStatus.UPLOADED);

    const lastDispatchedAt = documents
      .map((d) => d.dispatchedAt)
      .filter((v): v is Date => !!v)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    let state: 'READY' | 'PREPARING' | 'NONE' = 'NONE';
    let message = 'No audit paperwork has been prepared for this branch yet. You will be notified when it is sent.';
    if (documents.length > 0) {
      state = 'READY';
      message = `${documents.length} document${documents.length === 1 ? '' : 's'} ready to download.`;
    } else if (awaiting.length > 0) {
      // Being explicit here is the point: the assayer knows paperwork exists and
      // is coming, rather than seeing a bare empty list and re-checking blindly.
      state = 'PREPARING';
      message = 'Your paperwork is prepared and will be sent by operations shortly. You will be notified the moment it is released.';
    }

    return {
      documents,
      readiness: {
        state,
        dispatchedCount: documents.length,
        awaitingDispatchCount: awaiting.length,
        message,
        lastDispatchedAt,
      },
    };
  }

  /**
   * The same readiness verdict as `findDispatchedForAssayer`, for many branches at once.
   *
   * The mobile app previously showed a "Packet PDF" button on every checked-in assignment and
   * only discovered whether anything existed *after* the assayer tapped it — so the common
   * case (paperwork not dispatched yet) looked like a broken download rather than a state.
   * Gating the button needs readiness up front for the whole list, and one query per
   * assignment would be an N+1 on the app's main screen.
   */
  async readinessForBranches(
    projectBranchIds: string[],
  ): Promise<Record<string, { state: 'READY' | 'PREPARING' | 'NONE'; dispatchedCount: number; message: string }>> {
    const out: Record<string, { state: 'READY' | 'PREPARING' | 'NONE'; dispatchedCount: number; message: string }> = {};
    const ids = [...new Set(projectBranchIds.filter(Boolean))];
    if (ids.length === 0) return out;

    const rows = await this.documentRepository.find({
      where: { projectBranchId: In(ids), type: In(DocumentService.ASSAYER_VISIBLE_TYPES) },
      select: { id: true, projectBranchId: true, status: true },
    });

    for (const id of ids) {
      const mine = rows.filter((d) => d.projectBranchId === id);
      const dispatched = mine.filter((d) => DocumentService.DISPATCHED_STATUSES.includes(d.status));
      const awaiting = mine.filter((d) => d.status === DocumentStatus.UPLOADED);

      if (dispatched.length > 0) {
        out[id] = {
          state: 'READY',
          dispatchedCount: dispatched.length,
          message: `${dispatched.length} document${dispatched.length === 1 ? '' : 's'} ready to download.`,
        };
      } else if (awaiting.length > 0) {
        out[id] = {
          state: 'PREPARING',
          dispatchedCount: 0,
          message: 'Your paperwork is prepared and will be sent by operations shortly.',
        };
      } else {
        out[id] = {
          state: 'NONE',
          dispatchedCount: 0,
          message: 'No audit paperwork has been prepared for this branch yet.',
        };
      }
    }
    return out;
  }

  /**
   * Authorises an assayer to download a specific document.
   *
   * Guards two things the download-token endpoint did not check at all: that the
   * document has actually been dispatched, and that it belongs to a branch this
   * assayer is assigned to. Without these, any authenticated assayer could mint a
   * token for any document id in the system, including another branch's paperwork.
   */
  async assertAssayerMayDownload(documentId: string, assayerId: string): Promise<void> {
    const doc = await this.findOne(documentId);

    if (!DocumentService.ASSAYER_VISIBLE_TYPES.includes(doc.type)) {
      throw new BadRequestException('This document type is not available to field assayers.');
    }
    if (!DocumentService.DISPATCHED_STATUSES.includes(doc.status)) {
      throw new BadRequestException(
        'This document has not been dispatched yet. It will become available once operations releases it.',
      );
    }

    // The document hangs off an assessment; the assayer must hold an active
    // assignment on the same project/branch.
    const assessment = doc.assessmentId
      ? await this.assessmentRepository.findOne({ where: { id: doc.assessmentId } }).catch(() => null)
      : null;
    if (!assessment) return; // Not branch-scoped (e.g. legacy row) — nothing further to check.

    const linked = await this.assignmentRepository
      .createQueryBuilder('a')
      .innerJoin('project_branches', 'pb', 'pb.id = a.project_branch_id')
      .where('a.assayer_id = :assayerId', { assayerId })
      .andWhere('a.is_active = true')
      .andWhere('pb.project_id = :projectId', { projectId: assessment.projectId })
      .andWhere('pb.branch_id = :branchId', { branchId: assessment.branchId })
      .getCount();

    if (linked === 0) {
      throw new BadRequestException('You are not assigned to the branch this document belongs to.');
    }
  }

  async findByProjectBranch(projectBranchId: string): Promise<DocumentEntity[]> {
    const pb = await this.projectBranchRepository.findOne({ where: { id: projectBranchId } }).catch(() => null);
    if (!pb) return [];

    const assessment = await this.assessmentRepository.findOne({
      where: { projectId: pb.projectId, branchId: pb.branchId, isActive: true },
    }).catch(() => null);
    if (!assessment) return [];

    return this.documentRepository.find({
      where: { assessmentId: assessment.id, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findByAssessment(assessmentId: string): Promise<DocumentEntity[]> {
    return this.documentRepository.find({
      where: { assessmentId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findByProject(projectId: string): Promise<DocumentEntity[]> {
    const assessments = await this.assessmentRepository.find({
      where: { projectId, isActive: true },
      select: ['id'],
    });

    // No assessments means no documents. This used to fall through to
    // `assessmentId: undefined`, which TypeORM drops from the WHERE clause entirely — so a
    // project with nothing in it returned every document in the system, across every project
    // and every client.
    if (assessments.length === 0) return [];

    return this.documentRepository.find({
      // `In(...)`, not a bare array cast to `any`. The array form compiled fine but emitted
      // `assessment_id = $1` with a Postgres array literal as the parameter, so the endpoint
      // failed with `invalid input syntax for type uuid: "{...}"` for any project that had
      // more than zero assessments — i.e. always, in practice.
      where: { assessmentId: In(assessments.map((a) => a.id)), isActive: true },
      relations: ['assessment', 'assessment.branch'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Sends a pre-field PDF to the assigned assayer.
   *
   * `method` distinguishes the scheduled job (AUTO, spec §8.2 — one day before the audit
   * date) from an operator pushing it early (MANUAL, §8.3). Both record who and when, so the
   * transport trail can be reconstructed.
   */
  async dispatchDocument(
    id: string,
    userId: string,
    method: DispatchMethod = DispatchMethod.MANUAL,
  ): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    if (doc.status !== DocumentStatus.UPLOADED) {
      throw new BadRequestException(
        `Document ${id} cannot be dispatched from status ${doc.status} — only UPLOADED documents can be dispatched.`,
      );
    }

    const saved = await this.updateStatus(id, DocumentStatus.DISPATCHED, userId);
    saved.dispatchedAt = new Date();
    saved.dispatchMethod = method;
    saved.dispatchedBy = userId === 'SYSTEM' ? null : userId;
    await this.documentRepository.save(saved);

    if (!doc.assessmentId) {
      this.logger.warn(
        `Document ${id} dispatched but has no assessmentId — the assayer cannot be resolved or notified.`,
      );
      return saved;
    }

    const assignment = await this.assignmentRepository.findOne({
      where: { assessmentId: doc.assessmentId, isActive: true },
      relations: ['assayer'],
    });

    if (!assignment) {
      // Before the Assessment backfill this was the silent failure mode: assignments carried
      // no assessment_id, so this lookup always returned null and documents reached DISPATCHED
      // with the assayer never told. Warn loudly rather than returning quietly.
      this.logger.warn(
        `Document ${id} dispatched for assessment ${doc.assessmentId} but no active assignment links to it — no assayer was notified.`,
      );
    }

    if (assignment?.assayer) {
      try {
        // Was `notificationService.create({ userId: assignment.assayerId })`, which passed an
        // assayer id into a column that foreign-keys to `users` — a FK violation swallowed by
        // this very catch block, so dispatch always looked successful while the assayer was
        // never told. notifyAssayer() owns that id translation.
        const { inAppDelivered } = await this.notificationService.notifyAssayer(
          assignment.assayerId,
          assignment.assayer.email,
          {
            title: 'New Audit PDF',
            message: `Audit PDF "${doc.fileName}" has been dispatched to you. Open your schedule to view and download.`,
            // Kept as a hand-rolled notifyAssayer rather than migrated to a catalog emit: no
            // catalog entry covers "pre-field PDF dispatched to the assayer" (DOCUMENT_UPLOADED
            // targets the office desk, DOCUMENT_REJECTED is the re-upload path), and inventing
            // one is out of scope here. Only the link is corrected — the frontend declares
            // `/assignments` and reads the record from `?id=`; there is no `/assignments/:id`
            // route, so the old path fell through to the dashboard and the assayer never saw
            // the PDF the notification was about.
            link: `/assignments?id=${assignment.id}`,
            data: { documentId: doc.id, assignmentId: assignment.id, type: 'document_dispatched' },
          },
          userId,
        );
        if (!inAppDelivered) {
          this.logger.warn(
            `Document ${id} dispatched to assayer ${assignment.assayerId} but no matching user account was found for "${assignment.assayer.email}" — in-app notification not created.`,
          );
        }
      } catch (err) {
        this.logger.error(`Failed to send dispatch notification for document ${id}:`, err);
      }
    }

    return saved;
  }

  async receiveDocument(id: string, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);

    // Two different artifacts arrive by two different routes, and conflating them broke the
    // return path:
    //   - a PRE_FIELD_AUDIT_PDF goes out to the assayer, so it must be DISPATCHED first;
    //   - an AUDITED_RETURN_PDF is uploaded *by* the assayer — it was never dispatched to
    //     anyone, so it lands at UPLOADED and is received in the same act.
    // Requiring DISPATCHED for both meant every audited return threw here, into the caller's
    // `.catch(() => {})`, leaving it stuck at UPLOADED and never reaching the Data Entry
    // Head's queue.
    const isAssayerReturn = doc.type === DocumentType.AUDITED_RETURN_PDF;
    const allowed = isAssayerReturn
      ? [DocumentStatus.UPLOADED, DocumentStatus.DISPATCHED]
      : [DocumentStatus.DISPATCHED];

    if (!allowed.includes(doc.status)) {
      throw new BadRequestException(
        `Document ${id} cannot be received from status ${doc.status} (expected one of ${allowed.join(', ')}).`,
      );
    }
    const saved = await this.updateStatus(id, DocumentStatus.RECEIVED, userId);
    saved.receivedAt = new Date();
    await this.documentRepository.save(saved);

    try {
      this.eventPublisher.publish('document:received', {
        eventType: 'document:received',
        documentId: saved.id,
        assessmentId: saved.assessmentId,
        fileName: saved.fileName,
        userId,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish document:received event:', err);
    }

    /**
     * Fired here rather than in `create()` on purpose. `create()` also stores pre-field PDFs
     * and generated audit packets, which are outbound — the desk has nothing to do with them
     * yet, and alerting on upload would page the document executives for paperwork on its way
     * *out*. RECEIVED is the single point at which a document has actually landed on the desk,
     * whichever route it took, so the alert fires once and only for work that exists.
     */
    const receivedFrom = doc.assessmentId
      ? await this.assignmentRepository.findOne({
          where: { assessmentId: doc.assessmentId, isActive: true },
          relations: ['assayer'],
        })
      : null;

    this.notificationDispatch.emitSafe({
      type: 'DOCUMENT_UPLOADED',
      entityType: 'DOCUMENT',
      entityId: saved.id,
      actorUserId: userId === 'SYSTEM' ? null : userId,
      dedupeKey: `DOCUMENT_UPLOADED:${saved.id}`,
      payload: {
        assayerName: receivedFrom?.assayer?.displayName ?? 'An assayer',
        documentName: saved.fileName,
        branchName: doc.assessment?.branch?.name ?? 'a branch',
      },
    });

    return saved;
  }

  /**
   * The Data Entry Head's queue of collected paperwork (spec §8.5 / §12.8).
   *
   * Per §12.8 the system deliberately does NOT route work to individual data-entry operators:
   * every returned PDF lands here with the Head, who downloads it and distributes work through
   * the existing manual process. What the application owns is lifecycle, ownership and
   * progress tracking.
   *
   * Only documents that have actually come back are eligible — an audited-return PDF still
   * sitting in UPLOADED/DISPATCHED has not been returned yet and must not appear as pending
   * data-entry work. `daysPending` is computed from `received_at` (spec §8.5 asks for "days
   * pending"), falling back to createdAt for rows that predate transport tracking.
   */
  async findDataEntryQueue(): Promise<
    {
      assessmentId: string;
      project: string;
      branch: string;
      assayer: string | null;
      receivedAt: Date | null;
      daysPending: number | null;
      status: DocumentStatus;
      documents: DocumentEntity[];
    }[]
  > {
    const docs = await this.documentRepository.find({
      where: {
        type: DocumentType.AUDITED_RETURN_PDF,
        isActive: true,
        status: In([
          DocumentStatus.RECEIVED,
          DocumentStatus.SENT_TO_DATA_ENTRY,
          DocumentStatus.SENT_TO_EXTERNAL_OCR,
          DocumentStatus.EXCEL_GENERATED,
        ]),
      },
      relations: ['assessment', 'assessment.branch', 'assessment.project'],
      order: { receivedAt: 'ASC', createdAt: 'ASC' },
    });

    // Resolve assayers in one query rather than per document — this endpoint drives an
    // operational screen and must not degrade as the queue grows.
    const assessmentIds = [...new Set(docs.map((d) => d.assessmentId).filter(Boolean))] as string[];
    const assignments = assessmentIds.length
      ? await this.assignmentRepository.find({
          where: { assessmentId: In(assessmentIds), isActive: true },
          relations: ['assayer'],
        })
      : [];
    const assayerByAssessment = new Map(
      assignments.map((a) => [a.assessmentId as string, a.assayer?.displayName ?? null]),
    );

    const now = Date.now();
    const grouped = new Map<string, any>();
    for (const doc of docs) {
      const key = doc.assessmentId || 'unknown';
      if (!grouped.has(key)) {
        const since = doc.receivedAt ?? doc.createdAt;
        grouped.set(key, {
          assessmentId: key,
          project: doc.assessment?.project?.name || 'Unknown',
          branch: doc.assessment?.branch?.name || 'Unknown',
          assayer: assayerByAssessment.get(key) ?? null,
          receivedAt: doc.receivedAt ?? null,
          daysPending: since ? Math.floor((now - new Date(since).getTime()) / 86_400_000) : null,
          status: doc.status,
          documents: [],
        });
      }
      grouped.get(key)!.documents.push(doc);
    }
    return Array.from(grouped.values());
  }

  /**
   * Records that the Head has manually pushed this document into the external OCR
   * application. The OCR app is out of scope (spec §1) and integration is a later phase, so
   * this is the tracking step for a hand-off that happens outside the system.
   */
  async markSentToExternalOcr(id: string, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    if (doc.status !== DocumentStatus.RECEIVED && doc.status !== DocumentStatus.SENT_TO_DATA_ENTRY) {
      throw new BadRequestException(
        `Document ${id} cannot be sent to external OCR from status ${doc.status}.`,
      );
    }
    const saved = await this.updateStatus(id, DocumentStatus.SENT_TO_EXTERNAL_OCR, userId);
    saved.sentToExternalOcrAt = new Date();
    if (!saved.sentToDataEntryAt) saved.sentToDataEntryAt = new Date();
    await this.documentRepository.save(saved);

    return saved;
  }

  /**
   * The full transport history of one document — spec §8.6's "where is branch X's paperwork
   * right now", which the system previously could not answer because none of these timestamps
   * were recorded.
   *
   * Derived entirely from the document's own columns; no extra queries, so this stays cheap
   * enough to render inline in a list.
   */
  buildTransportTrail(doc: DocumentEntity): {
    stage: string;
    at: Date | null;
    by: string | null;
    method: DispatchMethod | null;
    done: boolean;
  }[] {
    const stages: { stage: string; at: Date | null; by: string | null; method: DispatchMethod | null }[] = [
      { stage: 'Uploaded', at: doc.createdAt ?? null, by: doc.createdBy ?? null, method: null },
      { stage: 'Dispatched to Assayer', at: doc.dispatchedAt, by: doc.dispatchedBy, method: doc.dispatchMethod },
      { stage: 'Received from Assayer', at: doc.receivedAt, by: null, method: null },
      { stage: 'Sent to Data Entry', at: doc.sentToDataEntryAt, by: null, method: null },
      { stage: 'Sent to External OCR', at: doc.sentToExternalOcrAt, by: null, method: null },
    ];
    return stages.map((s) => ({ ...s, done: s.at != null }));
  }

  async findAll(): Promise<DocumentEntity[]> {
    return this.documentRepository.find({
      where: { isActive: true },
      relations: ['assessment', 'assessment.branch', 'assessment.project'],
      order: { createdAt: 'DESC' },
    });
  }

  async getDocumentStats(): Promise<{ total: number; uploaded: number; dispatched: number; received: number }> {
    const all = await this.documentRepository.find({ where: { isActive: true } });
    return {
      total: all.length,
      uploaded: all.filter(d => d.status === DocumentStatus.UPLOADED).length,
      dispatched: all.filter(d => d.status === DocumentStatus.DISPATCHED).length,
      received: all.filter(d => d.status === DocumentStatus.RECEIVED).length,
    };
  }
}
