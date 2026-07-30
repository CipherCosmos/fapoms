import { Response } from 'express';
import { Repository } from 'typeorm';
import { DocumentService } from './document.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { DocumentStatus, DocumentType } from '@fapoms/shared';
export declare class DocumentController {
    private readonly documentService;
    private readonly localStorageService;
    private readonly ocrProcessingService;
    private readonly assignmentRepository;
    private readonly assessmentRepository;
    constructor(documentService: DocumentService, localStorageService: LocalStorageService, ocrProcessingService: OcrProcessingService, assignmentRepository: Repository<AssignmentEntity>, assessmentRepository: Repository<AssessmentEntity>);
    uploadFile(file: any, assessmentId: string, type: DocumentType, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    mobileUpload(body: any, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
        documentUrl: string;
    }>;
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
    downloadFile(id: string, res: Response): Promise<void>;
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
    downloadBranchPdf(projectBranchId: string, res: Response): Promise<void>;
    findByProjectBranch(projectBranchId: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
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
            project: string;
            branch: string;
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
}
