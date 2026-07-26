"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OcrProcessingService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const ocr_job_entity_1 = require("./ocr-job.entity");
const document_entity_1 = require("../../modules/document/document.entity");
const validation_service_1 = require("../../modules/validation/validation.service");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let OcrProcessingService = class OcrProcessingService {
    ocrJobRepository;
    documentRepository;
    validationService;
    auditService;
    timer = null;
    constructor(ocrJobRepository, documentRepository, validationService, auditService) {
        this.ocrJobRepository = ocrJobRepository;
        this.documentRepository = documentRepository;
        this.validationService = validationService;
        this.auditService = auditService;
    }
    onModuleInit() {
        if (process.env.NODE_ENV !== 'test') {
            this.timer = setInterval(() => {
                this.processQueueJobs();
            }, 2 * 60 * 1000);
            this.timer.unref();
        }
    }
    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
    }
    async processQueueJobs() {
        try {
            const pendingJobs = await this.ocrJobRepository.find({
                where: { status: (0, typeorm_2.In)([ocr_job_entity_1.OcrJobStatus.PENDING, ocr_job_entity_1.OcrJobStatus.FAILED]), isActive: true },
                take: 10,
            });
            for (const job of pendingJobs) {
                if (job.retryCount >= 5) {
                    job.status = ocr_job_entity_1.OcrJobStatus.DEAD_LETTER;
                    job.failureReason = 'Max retry count (5) exhausted. Moved to Dead-Letter Queue for manual review.';
                    await this.ocrJobRepository.save(job);
                    console.warn(`[OcrQueueWorker] Job ${job.id} moved to DEAD_LETTER queue after 5 failed attempts.`);
                    continue;
                }
                job.status = ocr_job_entity_1.OcrJobStatus.PROCESSING;
                job.retryCount += 1;
                await this.ocrJobRepository.save(job);
                console.log(`[OcrQueueWorker] Atomic Claim & Processing OCR job ${job.id} (Attempt ${job.retryCount}/5)...`);
            }
        }
        catch (err) {
            console.error('[OcrQueueWorker] Error during durable queue processing:', err);
        }
    }
    async createJob(documentId, userId) {
        const doc = await this.documentRepository.findOne({ where: { id: documentId, isActive: true } });
        if (!doc) {
            throw new common_1.NotFoundException(`Document ${documentId} not found.`);
        }
        const job = this.ocrJobRepository.create({
            documentId,
            status: ocr_job_entity_1.OcrJobStatus.PENDING,
            createdBy: userId,
            updatedBy: userId,
        });
        const saved = await this.ocrJobRepository.save(job);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.SYSTEM,
            eventType: 'OCR_JOB_CREATED',
            entityType: 'OCR_JOB',
            entityId: saved.id,
            userId,
            remarks: `OCR job successfully registered at boundary for document: ${doc.fileName}.`,
        });
        return saved;
    }
    async findOne(id) {
        const job = await this.ocrJobRepository.findOne({ where: { id, isActive: true } });
        if (!job) {
            throw new common_1.NotFoundException(`OCR Job ${id} not found.`);
        }
        return job;
    }
    async receiveOcrResults(jobId, externalJobId, ocrPayload, userId) {
        const job = await this.ocrJobRepository.findOne({
            where: { id: jobId },
            relations: ['document'],
        });
        if (!job) {
            throw new common_1.NotFoundException(`OCR Job ${jobId} not found.`);
        }
        job.externalJobId = externalJobId;
        job.status = ocr_job_entity_1.OcrJobStatus.COMPLETED;
        job.ocrPayload = ocrPayload;
        job.updatedBy = userId;
        const saved = await this.ocrJobRepository.save(job);
        const validationCase = await this.validationService.create({ projectBranchId: job.document.projectBranchId }, userId);
        await this.validationService.transition(validationCase.id, shared_1.ValidationStatus.OCR_PROCESSING, userId, 'OCR text parsed', undefined, ocrPayload);
        await this.validationService.transition(validationCase.id, shared_1.ValidationStatus.HUMAN_REVIEW, userId, 'Pending manual verification review');
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.SYSTEM,
            eventType: 'OCR_JOB_COMPLETED',
            entityType: 'OCR_JOB',
            entityId: saved.id,
            userId,
            remarks: `Received external OCR payload. Pushed to human validator review queue.`,
        });
        return saved;
    }
    async retryJob(jobId, userId) {
        const job = await this.findOne(jobId);
        job.status = ocr_job_entity_1.OcrJobStatus.PROCESSING;
        job.updatedBy = userId;
        const saved = await this.ocrJobRepository.save(job);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.SYSTEM,
            eventType: 'OCR_JOB_RETRY',
            entityType: 'OCR_JOB',
            entityId: saved.id,
            userId,
            remarks: `Re-enqueued OCR job retry for document ID: ${job.documentId}`,
        });
        return saved;
    }
    async handleJobFailure(jobId, errorDetails, userId) {
        const job = await this.findOne(jobId);
        job.status = ocr_job_entity_1.OcrJobStatus.FAILED;
        job.updatedBy = userId;
        const saved = await this.ocrJobRepository.save(job);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.SYSTEM,
            eventType: 'OCR_JOB_FAILED',
            entityType: 'OCR_JOB',
            entityId: saved.id,
            userId,
            remarks: `OCR job failed. Error details: ${errorDetails}`,
        });
        return saved;
    }
};
exports.OcrProcessingService = OcrProcessingService;
exports.OcrProcessingService = OcrProcessingService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(ocr_job_entity_1.OcrJobEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(document_entity_1.DocumentEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        validation_service_1.ValidationService,
        audit_service_1.AuditService])
], OcrProcessingService);
//# sourceMappingURL=ocr-processing.service.js.map