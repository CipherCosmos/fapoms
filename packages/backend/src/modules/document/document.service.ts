import { Injectable, NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { EventCategory, DocumentStatus, DocumentType, AssessmentStatus, DispatchMethod } from '@fapoms/shared';

export interface CreateDocumentDto {
  assessmentId: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType?: string;
  type: DocumentType;
}

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

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
    private readonly localStorageService: LocalStorageService,
  ) {}

  async create(dto: CreateDocumentDto, userId: string): Promise<DocumentEntity> {
    let assessment = await this.assessmentRepository.findOne({
      where: { id: dto.assessmentId, isActive: true },
    }).catch(() => null);

    if (!assessment) {
      let pb = await this.projectBranchRepository.findOne({ where: { id: dto.assessmentId } }).catch(() => null);
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

    const doc = this.documentRepository.create({
      assessmentId: assessment.id,
      fileName: dto.fileName,
      filePath: dto.filePath,
      fileSize: dto.fileSize,
      mimeType: dto.mimeType ?? null,
      type: dto.type,
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
