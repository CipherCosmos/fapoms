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
import { PushNotificationService } from '../notifications/push-notification.service';
import { EventCategory, DocumentStatus, DocumentType, AssessmentStatus, DispatchMethod } from '@fapoms/shared';

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
   * The head's distribution board: every returned packet at the desk, with who
   * owns it. Status alone said a packet had arrived but not who was working it,
   * so allocation happened outside the system and nothing could be chased.
   */
  async dataEntryQueue(assignedTo?: string): Promise<any> {
    const qb = this.documentRepository
      .createQueryBuilder('d')
      .leftJoin('project_branches', 'pb', 'pb.id = d.project_branch_id')
      .leftJoin('branches', 'b', 'b.id = pb.branch_id')
      .leftJoin('users', 'u', 'u.id = d.assigned_to_user_id')
      .select([
        'd.id AS id', 'd.file_name AS "fileName"', 'd.status AS status',
        'd.received_at AS "receivedAt"', 'd.sent_to_data_entry_at AS "sentToDataEntryAt"',
        'd.assigned_to_user_id AS "assignedToUserId"', 'd.assigned_at AS "assignedAt"',
        'd.data_entry_completed_at AS "completedAt"',
        'd.project_branch_id AS "projectBranchId"',
        'b.name AS "branchName"', 'b.branch_code AS "branchCode"',
        `COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''), u.username) AS "assigneeName"`,
      ])
      .where('d.is_active = true')
      .andWhere('d.type = :type', { type: DocumentType.AUDITED_RETURN_PDF })
      .andWhere('d.status IN (:...statuses)', {
        statuses: [DocumentStatus.RECEIVED, DocumentStatus.SENT_TO_DATA_ENTRY, DocumentStatus.SENT_TO_EXTERNAL_OCR],
      });

    if (assignedTo === 'unassigned') qb.andWhere('d.assigned_to_user_id IS NULL');
    else if (assignedTo) qb.andWhere('d.assigned_to_user_id = :uid', { uid: assignedTo });

    const rows = await qb.orderBy('d.received_at', 'ASC', 'NULLS LAST').getRawMany();

    return {
      total: rows.length,
      unassigned: rows.filter((r: any) => !r.assignedToUserId).length,
      inProgress: rows.filter((r: any) => r.assignedToUserId && !r.completedAt).length,
      completed: rows.filter((r: any) => r.completedAt).length,
      items: rows,
    };
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
        AND r.name IN ('DATA_ENTRY_HEAD', 'DOCUMENT_EXECUTIVE', 'VALIDATOR')
      ORDER BY name
    `);
  }

  /** Head delegates a returned packet to a team member. */
  async assignForDataEntry(documentId: string, assigneeId: string, actorId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(documentId);
    if (doc.type !== DocumentType.AUDITED_RETURN_PDF) {
      throw new BadRequestException('Only returned audit packets are delegated to data entry.');
    }
    doc.assignedToUserId = assigneeId;
    doc.assignedAt = new Date();
    doc.assignedBy = actorId;
    doc.dataEntryCompletedAt = null;
    if (doc.status === DocumentStatus.RECEIVED) {
      doc.status = DocumentStatus.SENT_TO_DATA_ENTRY;
      doc.sentToDataEntryAt = doc.sentToDataEntryAt ?? new Date();
    }
    doc.updatedBy = actorId;
    const saved = await this.documentRepository.save(doc);

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
         * The flag travels back to the caller so the UI can say "saved, but the reviewer has
         * not been notified — please tell your supervisor" instead of a plain success.
         */
        this.logger.error(
          `Hand-back saved for branch ${doc.projectBranchId} but its validation case did not advance to review: ${(e as Error).message}`,
        );
        (saved as any).validationAdvanced = false;
        (saved as any).validationWarning =
          'Your work was saved, but the reviewer was not notified automatically. Please tell your supervisor so this packet is not missed.';
      }
    }
    return saved;
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
              status: AssessmentStatus.PENDING_PLANNING,
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
    await this.syncAssessmentFromDocument(saved, userId);

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

  async updateStatus(id: string, status: DocumentStatus, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    const prevStatus = doc.status;
    doc.status = status;
    doc.updatedBy = userId;

    const saved = await this.documentRepository.save(doc);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
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
  async operationsOverview(filters: { projectId?: string; status?: string; type?: string } = {}): Promise<any> {
    const where: string[] = ['d.is_active = true'];
    const params: any[] = [];
    if (filters.projectId) { params.push(filters.projectId); where.push(`a.project_id = $${params.length}`); }
    if (filters.status) { params.push(filters.status); where.push(`d.status = $${params.length}`); }
    if (filters.type) { params.push(filters.type); where.push(`d.type = $${params.length}`); }

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
        WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC`,
      params,
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

    // Pipeline counts, in lifecycle order rather than alphabetical, so the shape of
    // the backlog is readable at a glance.
    const stageOrder = [
      DocumentStatus.UPLOADED, DocumentStatus.DISPATCHED, DocumentStatus.RECEIVED,
      DocumentStatus.SENT_TO_DATA_ENTRY, DocumentStatus.SENT_TO_EXTERNAL_OCR,
      DocumentStatus.EXCEL_GENERATED, DocumentStatus.PROCESSED, DocumentStatus.COMPLETED,
    ];
    const pipeline = stageOrder.map((stage) => ({
      stage,
      count: documents.filter((d: any) => d.status === stage).length,
    }));

    // Paperwork prepared but not released, for a branch whose audit is already
    // scheduled — the assayer cannot start without it, so this is the queue that
    // actually blocks field work.
    const today = new Date().toISOString().slice(0, 10);
    const awaitingDispatch = documents
      .filter((d: any) => d.status === DocumentStatus.UPLOADED
        && DocumentService.ASSAYER_VISIBLE_TYPES.includes(d.type))
      .map((d: any) => ({
        ...d,
        // Negative = the audit date has already passed with paperwork unsent.
        daysUntilAudit: d.scheduledDate
          ? Math.round((new Date(d.scheduledDate).getTime() - new Date(today).getTime()) / 86400000)
          : null,
      }))
      .sort((a: any, b: any) => (a.daysUntilAudit ?? 9999) - (b.daysUntilAudit ?? 9999));

    // ── Branch-grouped view ──────────────────────────────────────────────
    //
    // The flat `documents` list above is one row per file, so a branch with two
    // documents (say a pre-audit PDF plus its returned paperwork) shows that
    // branch's name twice with nothing to indicate they're the same branch at two
    // different stages — reading as a duplicate rather than two files for one
    // branch. This groups by branch instead, and — critically — includes branches
    // that have *no* documents at all, which the flat list could never show.
    const branchWhere: string[] = ['pb.is_active = true'];
    const branchParams: any[] = [];
    if (filters.projectId) { branchParams.push(filters.projectId); branchWhere.push(`pb.project_id = $${branchParams.length}`); }

    const branchRows = await this.documentRepository.manager.query(
      `SELECT pb.id AS project_branch_id, pb.status AS pb_status, pb.scheduled_date,
              b.id AS branch_id, b.name AS branch_name, b.branch_code,
              p.id AS project_id, p.name AS project_name, p.project_number,
              c.name AS client_name,
              a.status AS assessment_status
         FROM project_branches pb
         JOIN branches b ON b.id = pb.branch_id
         JOIN projects p ON p.id = pb.project_id
         LEFT JOIN clients c ON c.id = p.client_id
         LEFT JOIN assessments a ON a.project_id = pb.project_id AND a.branch_id = pb.branch_id AND a.is_active = true
        WHERE ${branchWhere.join(' AND ')}
        ORDER BY b.name`,
      branchParams,
    );

    const docsByBranch = new Map<string, any[]>();
    for (const d of documents) {
      if (!d.projectBranchId) continue;
      if (!docsByBranch.has(d.projectBranchId)) docsByBranch.set(d.projectBranchId, []);
      docsByBranch.get(d.projectBranchId)!.push(d);
    }

    const branches = branchRows.map((r: any) => {
      const docs = docsByBranch.get(r.project_branch_id) ?? [];
      const documentsByType: Record<string, any[]> = {};
      for (const d of docs) {
        (documentsByType[d.type] ??= []).push(d);
      }
      const daysUntilAudit = r.scheduled_date
        ? Math.round((new Date(r.scheduled_date).getTime() - new Date(today).getTime()) / 86400000)
        : null;
      return {
        projectBranchId: r.project_branch_id,
        branchId: r.branch_id,
        branchName: r.branch_name,
        branchCode: r.branch_code,
        projectId: r.project_id,
        projectName: r.project_name,
        projectNumber: r.project_number,
        clientName: r.client_name,
        branchStatus: r.pb_status,
        assessmentStatus: r.assessment_status,
        scheduledDate: r.scheduled_date,
        daysUntilAudit,
        documentCount: docs.length,
        documentsByType,
      };
    });

    // An assayer is confirmed and a date is set, but the packet that they need to
    // do the audit was never even created — worse than "prepared but not sent",
    // this is "not prepared at all". Invisible to `awaitingDispatch` above because
    // that only looks at documents that already exist.
    const neverPrepared = branches
      .filter((br: any) =>
        br.scheduledDate
        && ['ASSIGNMENT_CONFIRMED', 'SCHEDULED'].includes(br.branchStatus)
        && !br.documentsByType[DocumentType.PRE_FIELD_AUDIT_PDF]?.length)
      .sort((a: any, b: any) => (a.daysUntilAudit ?? 9999) - (b.daysUntilAudit ?? 9999));

    return {
      documents,
      pipeline,
      branches,
      totals: {
        total: documents.length,
        awaitingDispatch: awaitingDispatch.length,
        neverPrepared: neverPrepared.length,
        // Sent to the field but the completed paperwork has not come back.
        outstandingReturns: documents.filter((d: any) =>
          d.status === DocumentStatus.DISPATCHED && d.type === DocumentType.PRE_FIELD_AUDIT_PDF).length,
        inDataEntry: documents.filter((d: any) => d.status === DocumentStatus.SENT_TO_DATA_ENTRY).length,
        completed: documents.filter((d: any) => d.status === DocumentStatus.COMPLETED).length,
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
    const assessmentIds = await this.assessmentRepository.find({
      where: { projectId, isActive: true },
      select: ['id'],
    });
    return this.documentRepository.find({
      where: { assessmentId: assessmentIds.length > 0 ? assessmentIds.map(a => a.id) as any : undefined, isActive: true },
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

    await this.syncAssessmentFromDocument(saved, userId);

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
            link: `/assignments/${assignment.id}`,
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

    await this.syncAssessmentFromDocument(saved, userId);

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

    return saved;
  }

  /**
   * Advances the Assessment lifecycle from a document event.
   *
   * The Assessment is the authoritative record of "where is this branch's audit", and twelve
   * of its eighteen states describe the document pipeline exclusively — ProjectBranchStatus
   * collapses that entire span into AUDIT_COMPLETED → VALIDATION_COMPLETED → CLOSED. Those
   * twelve states were unreachable because nothing ever wrote them, which is why the system
   * could not answer "where is branch X's paperwork right now".
   *
   * Single owner of that mapping, on purpose: the drift repaired earlier in this work came
   * from several code paths each writing status their own way.
   *
   * Only ever moves forward. `PIPELINE_ORDER` guards against a late-arriving event dragging an
   * assessment backwards (e.g. a stray dispatch after the paperwork is already at data entry).
   */
  private static readonly PIPELINE_ORDER: AssessmentStatus[] = [
    AssessmentStatus.PENDING_PLANNING,
    AssessmentStatus.ASSESSOR_RECOMMENDED,
    AssessmentStatus.IN_NEGOTIATION,
    AssessmentStatus.ASSIGNED_AND_SCHEDULED,
    AssessmentStatus.AWAITING_CLIENT_DATA,
    AssessmentStatus.CLIENT_DATA_RECEIVED,
    AssessmentStatus.PDF_GENERATED,
    AssessmentStatus.READY_FOR_DISPATCH,
    AssessmentStatus.DISPATCHED_TO_ASSESSOR,
    AssessmentStatus.AUDITED_PDF_RECEIVED,
    AssessmentStatus.SENT_TO_DATA_ENTRY,
    AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
    AssessmentStatus.REPORT_FINALIZED,
    AssessmentStatus.PENDING_HEAD_APPROVAL,
    AssessmentStatus.DELIVERED_TO_CLIENT,
    AssessmentStatus.COMPLETED,
  ];

  /** Which assessment state each document state implies. */
  private static readonly DOCUMENT_TO_ASSESSMENT: Partial<Record<DocumentStatus, AssessmentStatus>> = {
    [DocumentStatus.UPLOADED]: AssessmentStatus.READY_FOR_DISPATCH,
    [DocumentStatus.DISPATCHED]: AssessmentStatus.DISPATCHED_TO_ASSESSOR,
    [DocumentStatus.RECEIVED]: AssessmentStatus.AUDITED_PDF_RECEIVED,
    [DocumentStatus.SENT_TO_DATA_ENTRY]: AssessmentStatus.SENT_TO_DATA_ENTRY,
    [DocumentStatus.SENT_TO_EXTERNAL_OCR]: AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
    [DocumentStatus.EXCEL_GENERATED]: AssessmentStatus.REPORT_FINALIZED,
    [DocumentStatus.COMPLETED]: AssessmentStatus.DELIVERED_TO_CLIENT,
  };

  async syncAssessmentFromDocument(doc: DocumentEntity, userId: string): Promise<void> {
    if (!doc.assessmentId) return;

    // Only the two PDFs that actually move through the field/data-entry pipeline drive the
    // assessment. Excel reports and client master data are inputs/outputs, not transport
    // milestones, and would otherwise skew the state.
    const drivesPipeline =
      doc.type === DocumentType.PRE_FIELD_AUDIT_PDF || doc.type === DocumentType.AUDITED_RETURN_PDF;
    if (!drivesPipeline) return;

    const target = DocumentService.DOCUMENT_TO_ASSESSMENT[doc.status];
    if (!target) return;

    const assessment = await this.assessmentRepository
      .findOne({ where: { id: doc.assessmentId, isActive: true } })
      .catch(() => null);
    if (!assessment) return;

    const currentIdx = DocumentService.PIPELINE_ORDER.indexOf(assessment.status);
    const targetIdx = DocumentService.PIPELINE_ORDER.indexOf(target);
    // Unknown (e.g. UNASSIGNED / CLARIFICATION_NEEDED, which sit outside the linear pipeline)
    // or backwards — leave alone.
    if (targetIdx === -1 || currentIdx === -1 || targetIdx <= currentIdx) return;

    const previous = assessment.status;
    assessment.status = target;
    assessment.updatedBy = userId;
    await this.assessmentRepository.save(assessment);

    await this.auditService.recordEvent({
      category: EventCategory.WORKFLOW,
      eventType: 'ASSESSMENT_PIPELINE_ADVANCED',
      entityType: 'ASSESSMENT',
      entityId: assessment.id,
      previousState: previous,
      newState: target,
      userId,
      remarks: `Advanced by document "${doc.fileName}" (${doc.type} → ${doc.status}).`,
    });

    try {
      this.eventPublisher.publish('assessment:status-changed', {
        eventType: 'assessment:status-changed',
        assessmentId: assessment.id,
        previousStatus: previous,
        status: target,
        documentId: doc.id,
        userId,
        timestamp: new Date(),
      });
    } catch (err: any) {
      this.logger.error('Failed to publish assessment:status-changed event:', err?.message);
    }
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

    await this.syncAssessmentFromDocument(saved, userId);
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
