import { Response } from 'express';
import { Repository } from 'typeorm';
import { DocumentService } from './document.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { DocumentStatus, DocumentType } from '@fapoms/shared';
import { ValidationService } from '../validation/validation.service';
import { DocumentAccessTokenService } from './document-access-token.service';
import { ChunkedUploadService } from './chunked-upload.service';
import { AssignmentService } from '../assignment/assignment.service';
export declare class DocumentController {
    private readonly documentService;
    private readonly localStorageService;
    private readonly ocrProcessingService;
    private readonly assignmentRepository;
    private readonly assessmentRepository;
    private readonly validationService;
    private readonly assignmentService;
    private readonly documentAccessTokenService;
    private readonly chunkedUploadService;
    constructor(documentService: DocumentService, localStorageService: LocalStorageService, ocrProcessingService: OcrProcessingService, assignmentRepository: Repository<AssignmentEntity>, assessmentRepository: Repository<AssessmentEntity>, validationService: ValidationService, assignmentService: AssignmentService, documentAccessTokenService: DocumentAccessTokenService, chunkedUploadService: ChunkedUploadService);
    uploadFile(file: any, assessmentId: string, type: DocumentType, req: any, customerMasterVersionId?: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    mobileUpload(body: any, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
        documentUrl: string;
    }>;
    mobileUploadBinary(file: any, assessmentId: string, assignmentId: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    createUploadSession(body: {
        assessmentId: string;
        fileName: string;
        fileSize: number;
        chunkSize?: number;
    }, req: any): Promise<{
        success: boolean;
        data: import("./chunked-upload.service").UploadSession;
    }>;
    getUploadSession(uploadId: string): Promise<{
        success: boolean;
        data: {
            receivedChunks: number[];
            missingChunks: number[];
            progress: number;
            uploadId: string;
            assessmentId: string;
            fileName: string;
            fileSize: number;
            totalChunks: number;
            chunkSize: number;
            createdBy: string;
            createdAt: number;
        };
    }>;
    uploadChunk(uploadId: string, index: string, chunk: any): Promise<{
        success: boolean;
        data: {
            index: number;
            received: number;
            total: number;
        };
    }>;
    completeUpload(uploadId: string, body: {
        type?: DocumentType;
        assignmentId?: string;
    }, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    private completeAssignmentForReturn;
    validateCustomerExcel(file: any): Promise<{
        success: boolean;
        data: {
            summary: {
                totalRowsProcessed: number;
                uniqueAccountsCount: number;
                duplicateAccountsCount: number;
                uniqueBranchesCount: number;
                missingBranchCodesCount: number;
                status: string;
            };
            recommendation: string;
        };
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    downloadFile(id: string, token: string, req: any, res: Response): Promise<void>;
    issueDownloadToken(id: string, req: any): Promise<{
        success: boolean;
        data: {
            downloadUrl: string;
            token: string;
            expiresAt: number;
        };
    }>;
    getTransportTrail(id: string): Promise<{
        success: boolean;
        data: {
            documentId: string;
            fileName: string;
            type: DocumentType;
            status: DocumentStatus;
            assessmentId: string | null;
            branch: string | null;
            project: string | null;
            trail: {
                stage: string;
                at: Date | null;
                by: string | null;
                method: import("@fapoms/shared").DispatchMethod | null;
                done: boolean;
            }[];
        };
    }>;
    updateStatus(id: string, dto: {
        status: DocumentStatus;
    }, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    dispatchDocument(id: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
        message: string;
    }>;
    receiveDocument(id: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
        message: string;
    }>;
    downloadBranchPdf(projectBranchId: string, req: any, res: Response): Promise<void>;
    findByProjectBranch(projectBranchId: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
        meta: {
            readiness: {
                state: "READY" | "PREPARING" | "NONE";
                dispatchedCount: number;
                awaitingDispatchCount: number;
                message: string;
                lastDispatchedAt: Date | null;
            };
        };
    } | {
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
        meta?: undefined;
    }>;
    operationsOverview(projectId?: string, status?: string, type?: string): Promise<{
        success: boolean;
        data: any;
    }>;
    uploadGeneratedBatch(files: any[], projectId: string, auditDate: string, req: any, customerMasterVersionId?: string): Promise<{
        success: boolean;
        data: {
            created: {
                documentId: string;
                fileName: string;
                branchName: string;
            }[];
            unmatched: {
                fileName: string;
                reason: string;
            }[];
            failed: {
                fileName: string;
                reason: string;
            }[];
            branchesWithoutFile: {
                projectBranchId: string;
                branchName: string;
                branchCode: string | null;
            }[];
        };
        message: string;
    }>;
    dispatchBatch(body: {
        documentIds: string[];
    }, req: any): Promise<{
        success: boolean;
        data: {
            dispatched: string[];
            failed: Array<{
                documentId: string;
                reason: string;
            }>;
        };
        message: string;
    }>;
    assayerBranchDocuments(projectBranchId: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
        meta: {
            readiness: {
                state: "READY" | "PREPARING" | "NONE";
                dispatchedCount: number;
                awaitingDispatchCount: number;
                message: string;
                lastDispatchedAt: Date | null;
            };
        };
    }>;
    findByAssessment(assessmentId: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
    }>;
    findByProject(projectId: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
    }>;
    findAll(): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
    }>;
    getStats(): Promise<{
        success: boolean;
        data: {
            total: number;
            uploaded: number;
            dispatched: number;
            received: number;
        };
    }>;
    getDataEntryQueue(): Promise<{
        success: boolean;
        data: {
            assessmentId: string;
            project: string;
            branch: string;
            assayer: string | null;
            receivedAt: Date | null;
            daysPending: number | null;
            status: DocumentStatus;
            documents: import("./document.entity").DocumentEntity[];
        }[];
    }>;
    sendToExternalOcr(id: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
        message: string;
    }>;
    uploadExcelReport(file: any, assessmentId: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
        message: string;
    }>;
    dataEntryQueue(assignedTo?: string): Promise<{
        success: boolean;
        data: any;
    }>;
    myDataEntryQueue(req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    dataEntryTeam(): Promise<{
        success: boolean;
        data: any[];
    }>;
    assignDataEntry(id: string, body: {
        assigneeId: string;
    }, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    completeDataEntry(id: string, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
}
