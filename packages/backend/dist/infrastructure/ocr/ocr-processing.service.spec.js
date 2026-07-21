"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const ocr_processing_service_1 = require("./ocr-processing.service");
const ocr_job_entity_1 = require("./ocr-job.entity");
const document_entity_1 = require("../../modules/document/document.entity");
const validation_service_1 = require("../../modules/validation/validation.service");
const audit_service_1 = require("../../core/audit/audit.service");
describe('OcrProcessingService', () => {
    let service;
    let ocrJobRepo;
    let documentRepo;
    const mockOcrJobRepo = {
        create: jest.fn(),
        save: jest.fn(),
        findOne: jest.fn(),
    };
    const mockDocumentRepo = {
        findOne: jest.fn(),
    };
    const mockValidationService = {
        create: jest.fn(),
        transition: jest.fn(),
    };
    const mockAuditService = {
        recordEvent: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                ocr_processing_service_1.OcrProcessingService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(ocr_job_entity_1.OcrJobEntity),
                    useValue: mockOcrJobRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(document_entity_1.DocumentEntity),
                    useValue: mockDocumentRepo,
                },
                {
                    provide: validation_service_1.ValidationService,
                    useValue: mockValidationService,
                },
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
                },
            ],
        }).compile();
        service = module.get(ocr_processing_service_1.OcrProcessingService);
        ocrJobRepo = module.get((0, typeorm_1.getRepositoryToken)(ocr_job_entity_1.OcrJobEntity));
        documentRepo = module.get((0, typeorm_1.getRepositoryToken)(document_entity_1.DocumentEntity));
        jest.clearAllMocks();
    });
    describe('createJob', () => {
        it('should throw NotFoundException if document does not exist', async () => {
            mockDocumentRepo.findOne.mockResolvedValue(null);
            await expect(service.createJob('doc-missing', 'user-1')).rejects.toThrow(common_1.NotFoundException);
        });
    });
});
//# sourceMappingURL=ocr-processing.service.spec.js.map