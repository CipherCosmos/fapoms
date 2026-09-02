import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bull';
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
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
  };

  const mockOcrQueue = {
    add: jest.fn(),
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
        {
          provide: getQueueToken('ocr'),
          useValue: mockOcrQueue,
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

    /**
     * `removeOnComplete: false, removeOnFail: false` meant every OCR job this queue had ever run
     * stayed in Redis — one entry per uploaded audit packet, never removed. Redis runs with
     * `maxmemory` and `noeviction` in production (bull-queue-manager.ts), so an unbounded key set
     * does not quietly evict a cache key to make room: Redis refuses writes, taking the cache, the
     * rate limiters and every other queue down with it.
     */
    it('enqueues with bounded retention on both the completed and the failed set', async () => {
      mockDocumentRepo.findOne.mockResolvedValue({ id: 'doc-1', fileName: 'packet.pdf', isActive: true });
      mockOcrJobRepo.create.mockImplementation((v: any) => v);
      mockOcrJobRepo.save.mockResolvedValue({ id: 'job-1' });

      await service.createJob('doc-1', 'user-1');

      const opts = mockOcrQueue.add.mock.calls[0][2];
      expect(opts.removeOnComplete).not.toBe(false);
      expect(opts.removeOnFail).not.toBe(false);
      expect(opts.removeOnComplete).toEqual({ age: expect.any(Number), count: expect.any(Number) });
      expect(opts.removeOnFail).toEqual({ age: expect.any(Number), count: expect.any(Number) });

      // Failures outlive successes: with `attempts: 5` behind an exponential backoff, a job that
      // has genuinely exhausted its retries is the one an operator asks about tomorrow, and its
      // `failedReason` is the only record of why the packet never came back parsed.
      expect(opts.removeOnFail.age).toBeGreaterThan(opts.removeOnComplete.age);
    });
  });
});
