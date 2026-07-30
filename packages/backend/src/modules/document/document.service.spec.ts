import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { DocumentService } from './document.service';
import { DocumentEntity } from './document.entity';
import { AssessmentEntity } from '../project/assessment.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { DocumentType } from '@fapoms/shared';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';

describe('DocumentService', () => {
  let service: DocumentService;

  const mockDocumentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockAssessmentRepo = {
    findOne: jest.fn(),
  };

  const mockAssignmentRepo = {
    findOne: jest.fn().mockResolvedValue(null),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  const mockEventPublisher = {
    publish: jest.fn(),
  };

  const mockNotificationService = {
    create: jest.fn(),
  };

  const mockPushNotificationService = {
    sendToUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentService,
        { provide: getRepositoryToken(DocumentEntity), useValue: mockDocumentRepo },
        { provide: getRepositoryToken(AssessmentEntity), useValue: mockAssessmentRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: { findOne: jest.fn().mockResolvedValue(null) } },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: AuditService, useValue: mockAuditService },
        { provide: DomainEventPublisher, useValue: mockEventPublisher },
        { provide: NotificationService, useValue: mockNotificationService },
        { provide: PushNotificationService, useValue: mockPushNotificationService },
        { provide: LocalStorageService, useValue: { saveFile: jest.fn(), getFilePath: jest.fn() } },
      ],
    }).compile();

    service = module.get<DocumentService>(DocumentService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw NotFoundException if assessment does not exist', async () => {
      mockAssessmentRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          {
            assessmentId: 'asmt-missing',
            fileName: 'test.pdf',
            filePath: '/path/test.pdf',
            fileSize: 1024,
            type: DocumentType.PRE_FIELD_AUDIT_PDF,
          },
          'user-1',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
