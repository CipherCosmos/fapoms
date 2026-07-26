import { BaseEntity } from '../../core/entities/base.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
export declare enum OcrJobStatus {
    PENDING = "PENDING",
    PROCESSING = "PROCESSING",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED",
    DEAD_LETTER = "DEAD_LETTER"
}
export declare class OcrJobEntity extends BaseEntity {
    documentId: string;
    externalJobId: string | null;
    status: OcrJobStatus;
    ocrPayload: any | null;
    retryCount: number;
    failureReason: string | null;
    externalCorrelationId: string | null;
    lastAttemptAt: Date | null;
    nextRetryAt: Date | null;
    callbackReceivedAt: Date | null;
    completedAt: Date | null;
    document: DocumentEntity;
}
