import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { OcrProcessingService } from './ocr-processing.service';
import { OcrJobEntity } from './ocr-job.entity';
import { DocumentEntity } from '../../modules/document/document.entity';
import { ValidationService } from '../../modules/validation/validation.service';
import { AuditService } from '../../core/audit/audit.service';

describe('OcrProcessingService', () => {
  let service: OcrProcessingService;
  let ocrJobRepo: Repository<OcrJobEntity>;
  let documentRepo: Repository<DocumentEntity>;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OcrProcessingService,
        {
          provide: getRepositoryToken(OcrJobEntity),
          useValue: mockOcrJobRepo,
        },
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: mockDocumentRepo,
        },
        {
          provide: ValidationService,
          useValue: mockValidationService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
      ],
    }).compile();

    service = module.get<OcrProcessingService>(OcrProcessingService);
    ocrJobRepo = module.get<Repository<OcrJobEntity>>(getRepositoryToken(OcrJobEntity));
    documentRepo = module.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));

    jest.clearAllMocks();
  });

  describe('createJob', () => {
    it('should throw NotFoundException if document does not exist', async () => {
      mockDocumentRepo.findOne.mockResolvedValue(null);

      await expect(service.createJob('doc-missing', 'user-1')).rejects.toThrow(NotFoundException);
    });
  });
});
