import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { EventCategory, DocumentStatus, DocumentType, AssessmentStatus } from '@fapoms/shared';

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

  async findByProjectBranch(projectBranchId: string): Promise<DocumentEntity[]> {
    const pb = await this.projectBranchRepository.findOne({ where: { id: projectBranchId } }).catch(() => null);
    if (!pb) return [];
    let assessment = await this.assessmentRepository.findOne({
      where: { projectId: pb.projectId, branchId: pb.branchId, isActive: true },
    }).catch(() => null);
    if (!assessment) {
      assessment = await this.assessmentRepository.save(
        this.assessmentRepository.create({
          projectId: pb.projectId,
          branchId: pb.branchId,
          status: AssessmentStatus.PENDING_PLANNING,
          createdBy: '00000000-0000-0000-0000-000000000000',
          updatedBy: '00000000-0000-0000-0000-000000000000',
        }),
      );
    }
    const docs = await this.documentRepository.find({
      where: { assessmentId: assessment.id, isActive: true },
      order: { createdAt: 'DESC' },
    });

    if (docs.length === 0) {
      const fileName = `PreAudit_CustomerMaster_${pb.id.slice(0, 8)}.pdf`;
      const pdfBuffer = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length 110 >>\nstream\nBT\n/F1 18 Tf\n50 720 Td\n(FAPOMS PRE-AUDIT CUSTOMER MASTER REPORT) Tj\n0 -30 Td\n/F1 12 Tf\n(Branch ID: ${pb.id}) Tj\nET\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000404 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n482\n%%EOF`);
      
      const savedFilePath = await this.localStorageService.saveFile(fileName, pdfBuffer).catch(() => `pre-audit/customer_master_${pb.id.slice(0, 8)}.pdf`);

      const defaultDoc = await this.documentRepository.save(
        this.documentRepository.create({
          assessmentId: assessment.id,
          fileName,
          filePath: savedFilePath,
          fileSize: pdfBuffer.length,
          mimeType: 'application/pdf',
          type: DocumentType.CUSTOMER_MASTER_DATA,
          status: DocumentStatus.DISPATCHED,
          createdBy: '00000000-0000-0000-0000-000000000000',
          updatedBy: '00000000-0000-0000-0000-000000000000',
        }),
      );
      return [defaultDoc];
    }

    return docs;
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

  async dispatchDocument(id: string, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    if (doc.status !== DocumentStatus.UPLOADED) {
      throw new NotFoundException(`Document ${id} cannot be dispatched from status ${doc.status}.`);
    }

    const saved = await this.updateStatus(id, DocumentStatus.DISPATCHED, userId);

    if (!doc.assessmentId) return saved;

    const assignment = await this.assignmentRepository.findOne({
      where: { assessmentId: doc.assessmentId, isActive: true },
      relations: ['assayer'],
    });

    if (assignment?.assayer) {
      try {
        await this.notificationService.create({
          userId: assignment.assayerId,
          title: 'New Audit PDF',
          message: `Audit PDF "${doc.fileName}" has been dispatched to you for assessment.`,
          link: `/assignments/${assignment.id}`,
        }, userId);

        await this.pushNotificationService.sendToUser(
          assignment.assayerId,
          'New Audit PDF',
          `Audit PDF "${doc.fileName}" has been assigned to you. Open your schedule to view and download.`,
          { documentId: doc.id, assignmentId: assignment.id, type: 'document_dispatched' },
        );
      } catch (err) {
        console.error('Failed to send dispatch notification:', err);
      }
    }

    return saved;
  }

  async receiveDocument(id: string, userId: string): Promise<DocumentEntity> {
    const doc = await this.findOne(id);
    if (doc.status !== DocumentStatus.DISPATCHED) {
      throw new NotFoundException(`Document ${id} cannot be received from status ${doc.status}.`);
    }
    const saved = await this.updateStatus(id, DocumentStatus.RECEIVED, userId);

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

  async findDataEntryQueue(): Promise<{ project: string; branch: string; documents: DocumentEntity[] }[]> {
    const docs = await this.documentRepository.find({
      where: { type: DocumentType.AUDITED_RETURN_PDF, isActive: true },
      relations: ['assessment', 'assessment.branch', 'assessment.project'],
      order: { createdAt: 'ASC' },
    });

    const grouped = new Map<string, { project: string; branch: string; documents: DocumentEntity[] }>();
    for (const doc of docs) {
      const key = doc.assessmentId || 'unknown';
      if (!grouped.has(key)) {
        grouped.set(key, {
          project: doc.assessment?.project?.name || 'Unknown',
          branch: doc.assessment?.branch?.name || 'Unknown',
          documents: [],
        });
      }
      grouped.get(key)!.documents.push(doc);
    }
    return Array.from(grouped.values());
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
