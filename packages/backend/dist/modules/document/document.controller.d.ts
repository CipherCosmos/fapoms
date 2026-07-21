import { Response } from 'express';
import { DocumentService } from './document.service';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { OcrProcessingService } from '../../infrastructure/ocr/ocr-processing.service';
import { DocumentStatus, DocumentType } from '@fapoms/shared';
declare class UpdateDocumentStatusDto {
    status: DocumentStatus;
}
export declare class DocumentController {
    private readonly documentService;
    private readonly localStorageService;
    private readonly ocrProcessingService;
    constructor(documentService: DocumentService, localStorageService: LocalStorageService, ocrProcessingService: OcrProcessingService);
    uploadFile(file: any, projectBranchId: string, type: DocumentType, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    downloadFile(id: string, res: Response): Promise<void>;
    updateStatus(id: string, dto: UpdateDocumentStatusDto, req: any): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity;
    }>;
    findByProjectBranch(projectBranchId: string): Promise<{
        success: boolean;
        data: import("./document.entity").DocumentEntity[];
    }>;
}
export {};
