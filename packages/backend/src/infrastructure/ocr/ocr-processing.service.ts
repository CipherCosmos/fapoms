import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { OcrJobEntity, OcrJobStatus } from './ocr-job.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
import { ValidationService } from '../../modules/validation/validation.service';
import { AuditService } from '../../core/audit/audit.service';
import { FAILED_JOB_RETENTION } from '../queue/queued-job';
import { EventCategory, ValidationStatus } from '@fapoms/shared';
import type { KeepJobsOptions } from 'bull';

/**
 * How long a *completed* OCR dispatch is kept in Redis.
 *
 * Declared here rather than shared, for the reason queued-job.ts gives: completed retention is
 * per-queue because the payloads are not comparable. This one is three ids and a filename — a few
 * hundred bytes — so the count can be generous, but the *durable* record of an OCR job is the
 * `ocr_jobs` row in Postgres, which this Bull entry only exists to dispatch. Once the job has run,
 * keeping the envelope buys nothing an operator would ever read, so a day is the whole window.
 *
 * Failures use the shared FAILED_JOB_RETENTION (a week) for the reason it documents: with
 * `attempts: 5` behind an exponential backoff, a job that has genuinely exhausted its retries is
 * the one someone asks about, and its `failedReason` is the only record of why the document never
 * came back parsed.
 */
const OCR_COMPLETED_RETENTION: KeepJobsOptions = { age: 24 * 60 * 60, count: 1000 };

@Injectable()
export class OcrProcessingService {
  constructor(
    @InjectRepository(OcrJobEntity)
    private readonly ocrJobRepository: Repository<OcrJobEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    private readonly validationService: ValidationService,
    private readonly auditService: AuditService,
    @InjectQueue('ocr') private readonly ocrQueue: Queue,
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
      remarks: `OCR job registered for document: ${doc.fileName}.`,
    });

    await this.ocrQueue.add(
      'process',
      { documentId, userId, fileName: doc.fileName },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        /**
         * Retention, not "keep everything forever".
         *
         * `false` on both meant every OCR job this queue had ever run stayed in Redis — one entry
         * per uploaded audit packet, never removed, on the same instance that holds the cache, the
         * rate-limit counters and every other queue. Redis runs with `maxmemory` and `noeviction`
         * in production (see bull-queue-manager.ts), so an unbounded key set does not quietly
         * evict a cache key to make room: Redis starts refusing writes, which takes down the
         * cache, the throttler and every other queue with it. `BullQueueManager` was fixed for
         * exactly this; this queue was missed.
         */
        removeOnComplete: OCR_COMPLETED_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    );

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

    const validationCase = await this.validationService.create({ projectBranchId: job.document.projectBranchId! }, userId);
    await this.validationService.transition(validationCase.id, ValidationStatus.OCR_PROCESSING, userId, 'OCR text parsed', undefined, ocrPayload);
    await this.validationService.transition(validationCase.id, ValidationStatus.HUMAN_REVIEW, userId, 'Pending manual verification review');

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'OCR_JOB_COMPLETED',
      entityType: 'OCR_JOB',
      entityId: saved.id,
      userId,
      remarks: 'Received external OCR payload. Pushed to human validator review queue.',
    });

    return saved;
  }

  async retryJob(jobId: string, userId: string): Promise<OcrJobEntity> {
    const job = await this.findOne(jobId);
    job.status = OcrJobStatus.PROCESSING;
    job.updatedBy = userId;

    const saved = await this.ocrJobRepository.save(job);

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'OCR_JOB_RETRY',
      entityType: 'OCR_JOB',
      entityId: saved.id,
      userId,
      remarks: `Re-enqueued OCR job retry for document ID: ${job.documentId}`,
    });

    return saved;
  }

  async handleJobFailure(jobId: string, errorDetails: string, userId: string): Promise<OcrJobEntity> {
    const job = await this.findOne(jobId);
    job.status = OcrJobStatus.FAILED;
    job.updatedBy = userId;

    const saved = await this.ocrJobRepository.save(job);

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'OCR_JOB_FAILED',
      entityType: 'OCR_JOB',
      entityId: saved.id,
      userId,
      remarks: `OCR job failed. Error details: ${errorDetails}`,
    });

    return saved;
  }
}
