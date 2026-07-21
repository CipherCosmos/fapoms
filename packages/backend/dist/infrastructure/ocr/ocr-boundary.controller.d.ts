import { OcrProcessingService } from './ocr-processing.service';
declare class ReceiveOcrResultsDto {
    externalJobId: string;
    ocrPayload: any;
}
export declare class OcrBoundaryController {
    private readonly ocrProcessingService;
    constructor(ocrProcessingService: OcrProcessingService);
    createJob(documentId: string, req: any): Promise<{
        success: boolean;
        data: import("./ocr-job.entity").OcrJobEntity;
    }>;
    callbackOcr(id: string, dto: ReceiveOcrResultsDto, req: any): Promise<{
        success: boolean;
        data: import("./ocr-job.entity").OcrJobEntity;
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: import("./ocr-job.entity").OcrJobEntity;
    }>;
}
export {};
