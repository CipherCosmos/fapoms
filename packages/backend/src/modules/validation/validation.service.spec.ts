import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ValidationService } from './validation.service';
import { ValidationCaseEntity } from './validation-case.entity';
import { AuditService } from '../../core/audit/audit.service';
import { ValidationStatus } from '@fapoms/shared';
import { ProjectService } from '../project/project.service';
import { ProjectQueryService } from '../project/project-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { AssessmentEntity } from '../project/assessment.entity';

describe('ValidationService', () => {
  let service: ValidationService;
  let validationCaseRepo: Repository<ValidationCaseEntity>;

  const mockValidationCaseRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
  };

  const mockProjectService = {
    transitionProjectBranchStatus: jest.fn(),
    completeBranchValidation: jest.fn(),
    closeBranchProject: jest.fn(),
    initiateBranchPlanning: jest.fn(),
  };

  const mockProjectQueryService = {
    findProjectBranchById: mockProjectBranchRepo.findOne,
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  const mockDomainEventPublisher = {
    publish: jest.fn(),
  };

  const mockWorkflowEngine = {
    registerWorkflow: jest.fn(),
    executeCommand: jest.fn().mockImplementation(async (key, id, cmd, from, to, uid, role, roles, action) => action()),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ValidationService,
        {
          provide: getRepositoryToken(ValidationCaseEntity),
          useValue: mockValidationCaseRepo,
        },
        {
          provide: getRepositoryToken(AssessmentEntity),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: ProjectQueryService,
          useValue: mockProjectQueryService,
        },
        {
          provide: ProjectService,
          useValue: mockProjectService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: DomainEventPublisher,
          useValue: mockDomainEventPublisher,
        },
        {
          provide: WorkflowEngine,
          useValue: mockWorkflowEngine,
        },
      ],
    }).compile();

    service = module.get<ValidationService>(ValidationService);
    validationCaseRepo = module.get<Repository<ValidationCaseEntity>>(getRepositoryToken(ValidationCaseEntity));

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw NotFoundException if project branch does not exist', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create({ projectBranchId: 'pb-missing' }, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('assign', () => {
    it('should throw BadRequestException if transition to ASSIGNED is invalid', async () => {
      const mockCase = { id: 'v-1', status: ValidationStatus.APPROVED };
      mockValidationCaseRepo.findOne.mockResolvedValue(mockCase);

      await expect(service.assign('v-1', 'reviewer-1', 'user-1')).rejects.toThrow(BadRequestException);
    });
  });
});
