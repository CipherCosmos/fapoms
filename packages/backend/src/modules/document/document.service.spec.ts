import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './document.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DocumentType } from '@fapoms/shared';

describe('DocumentService', () => {
  let service: DocumentService;
  let documentRepo: Repository<DocumentEntity>;
  let projectBranchRepo: Repository<ProjectBranchEntity>;

  const mockDocumentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn(),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        {
          provide: getRepositoryToken(DocumentEntity),
          useValue: mockDocumentRepo,
        },
        {
          provide: getRepositoryToken(ProjectBranchEntity),
          useValue: mockProjectBranchRepo,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
    documentRepo = module.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    projectBranchRepo = module.get<Repository<ProjectBranchEntity>>(getRepositoryToken(ProjectBranchEntity));

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw NotFoundException if project branch does not exist', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          {
            projectBranchId: 'pb-missing',
            fileName: 'test.pdf',
            filePath: '/path/test.pdf',
            fileSize: 1024,
            type: DocumentType.GENERATED_PDF,
          },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
