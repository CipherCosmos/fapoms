import { BaseEntity } from '../../core/entities/base.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
export declare enum OcrJobStatus {
    PENDING = "PENDING",
    PROCESSING = "PROCESSING",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED"
}
export declare class OcrJobEntity extends BaseEntity {
    documentId: string;
    externalJobId: string | null;
    status: OcrJobStatus;
    ocrPayload: any | null;
    retryCount: number;
    failureReason: string | null;
    document: DocumentEntity;
}
