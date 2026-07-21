import { Repository } from 'typeorm';
import { OcrJobEntity } from './ocr-job.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
import { ValidationService } from '../../modules/validation/validation.service';
import { AuditService } from '../../core/audit/audit.service';
export declare class OcrProcessingService {
    private readonly ocrJobRepository;
    private readonly documentRepository;
    private readonly validationService;
    private readonly auditService;
    constructor(ocrJobRepository: Repository<OcrJobEntity>, documentRepository: Repository<DocumentEntity>, validationService: ValidationService, auditService: AuditService);
    createJob(documentId: string, userId: string): Promise<OcrJobEntity>;
    findOne(id: string): Promise<OcrJobEntity>;
    receiveOcrResults(jobId: string, externalJobId: string, ocrPayload: any, userId: string): Promise<OcrJobEntity>;
}
