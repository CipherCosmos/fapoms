import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OcrJobEntity, OcrJobStatus } from './ocr-job.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
import { ValidationService } from '../../modules/validation/validation.service';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, ValidationStatus } from '@fapoms/shared';

@Injectable()
export class OcrProcessingService {
  constructor(
    @InjectRepository(OcrJobEntity)
    private readonly ocrJobRepository: Repository<OcrJobEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly validationService: ValidationService,
    private readonly auditService: AuditService,
  ) {}

  async createJob(documentId: string, userId: string): Promise<OcrJobEntity> {
    const doc = await this.documentRepository.findOne({ where: { id: documentId, isActive: true } });
    if (!doc) {
      throw new NotFoundException(`Document ${documentId} not found.`);
    }

    const job = this.ocrJobRepository.create({
      documentId,
      status: OcrJobStatus.PENDING,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.ocrJobRepository.save(job);

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'OCR_JOB_CREATED',
      entityType: 'OCR_JOB',
      entityId: saved.id,
      userId,
      remarks: `OCR job successfully registered at boundary for document: ${doc.fileName}.`,
    });

    return saved;
  }

  async findOne(id: string): Promise<OcrJobEntity> {
    const job = await this.ocrJobRepository.findOne({ where: { id, isActive: true } });
    if (!job) {
      throw new NotFoundException(`OCR Job ${id} not found.`);
    }
    return job;
  }

  async receiveOcrResults(jobId: string, externalJobId: string, ocrPayload: any, userId: string): Promise<OcrJobEntity> {
    const job = await this.ocrJobRepository.findOne({
      where: { id: jobId },
      relations: ['document'],
    });

    if (!job) {
      throw new NotFoundException(`OCR Job ${jobId} not found.`);
    }

    job.externalJobId = externalJobId;
    job.status = OcrJobStatus.COMPLETED;
    job.ocrPayload = ocrPayload;
    job.updatedBy = userId;

    const saved = await this.ocrJobRepository.save(job);

    // Forward and transition straight into Validator reviews queue
    const validationCase = await this.validationService.create({ projectBranchId: job.document.projectBranchId }, userId);
    await this.validationService.transition(validationCase.id, ValidationStatus.OCR_PROCESSING, userId, 'OCR text parsed', undefined, ocrPayload);
    await this.validationService.transition(validationCase.id, ValidationStatus.HUMAN_REVIEW, userId, 'Pending manual verification review');

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'OCR_JOB_COMPLETED',
      entityType: 'OCR_JOB',
      entityId: saved.id,
      userId,
      remarks: `Received external OCR payload. Pushed to human validator review queue.`,
    });

    return saved;
  }
}
