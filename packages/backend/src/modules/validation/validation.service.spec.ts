import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ValidationService } from './validation.service';
import { ValidationCaseEntity } from './validation-case.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';
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
  let validationQueryRepo: any;

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
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
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
          // No unresolved clarifications by default, so the submit guard does not block.
          provide: getRepositoryToken(ValidationQueryEntity),
          useValue: { count: jest.fn().mockResolvedValue(0) },
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
    validationQueryRepo = module.get(getRepositoryToken(ValidationQueryEntity));

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

  describe('moveToReview', () => {
    it('advances a fresh PENDING case to HUMAN_REVIEW', async () => {
      const mockCase = { id: 'v-1', status: ValidationStatus.PENDING, projectBranch: {}, assessment: null };
      mockValidationCaseRepo.findOne.mockResolvedValue(mockCase);
      mockValidationCaseRepo.save.mockImplementation(async (c: any) => c);

      const result = await service.moveToReview('v-1', 'user-1', 'ready');

      expect(result.status).toBe(ValidationStatus.HUMAN_REVIEW);
    });

    it('advances CORRECTION_REQUIRED back to HUMAN_REVIEW — the loop that was previously dead', async () => {
      const mockCase = { id: 'v-1', status: ValidationStatus.CORRECTION_REQUIRED, projectBranch: {}, assessment: null };
      mockValidationCaseRepo.findOne.mockResolvedValue(mockCase);
      mockValidationCaseRepo.save.mockImplementation(async (c: any) => c);

      const result = await service.moveToReview('v-1', 'user-1');

      expect(result.status).toBe(ValidationStatus.HUMAN_REVIEW);
    });

    it('refuses to move an already-terminal APPROVED case back to review', async () => {
      const mockCase = { id: 'v-1', status: ValidationStatus.APPROVED };
      mockValidationCaseRepo.findOne.mockResolvedValue(mockCase);

      await expect(service.moveToReview('v-1', 'user-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('transition', () => {
    it('routes a HUMAN_REVIEW target through moveToReview rather than rejecting it', async () => {
      const mockCase = { id: 'v-1', status: ValidationStatus.PENDING, projectBranch: {}, assessment: null };
      mockValidationCaseRepo.findOne.mockResolvedValue(mockCase);
      mockValidationCaseRepo.save.mockImplementation(async (c: any) => c);

      const result = await service.transition('v-1', ValidationStatus.HUMAN_REVIEW, 'user-1');

      expect(result.status).toBe(ValidationStatus.HUMAN_REVIEW);
    });
  });

  describe('submit guard: open clarifications block submission', () => {
    it('refuses to submit a case to the client while a clarification is unresolved', async () => {
      mockValidationCaseRepo.findOne.mockResolvedValue({ id: 'v-1', status: ValidationStatus.APPROVED, projectBranch: {}, assessment: null });
      validationQueryRepo.count.mockResolvedValueOnce(2); // two unresolved clarifications

      await expect(service.transition('v-1', ValidationStatus.SUBMITTED, 'user-1')).rejects.toThrow(/unresolved/i);
    });

    it('allows submission once no clarification is open', async () => {
      mockValidationCaseRepo.findOne.mockResolvedValue({ id: 'v-1', status: ValidationStatus.APPROVED, projectBranch: {}, assessment: null });
      mockValidationCaseRepo.save.mockImplementation(async (c: any) => c);
      validationQueryRepo.count.mockResolvedValue(0);

      const result = await service.transition('v-1', ValidationStatus.SUBMITTED, 'user-1');
      expect(result.status).toBe(ValidationStatus.SUBMITTED);
    });
  });

  describe('getOrAdvanceForHandBack', () => {
    it('creates a case for a branch seeing its first hand-back, and moves it to HUMAN_REVIEW', async () => {
      mockValidationCaseRepo.findOne
        .mockResolvedValueOnce(null) // no existing case for this branch
        .mockResolvedValueOnce({ id: 'v-new', status: ValidationStatus.PENDING, projectBranch: {}, assessment: null }) // this.findOne(created.id) inside create()'s follow-up findOne
        .mockResolvedValueOnce({ id: 'v-new', status: ValidationStatus.PENDING, projectBranch: {}, assessment: null }); // moveToReview's own findOne
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', projectId: 'proj-1', branchId: 'branch-1' });
      mockValidationCaseRepo.create.mockImplementation((v: any) => v);
      mockValidationCaseRepo.save.mockImplementation(async (c: any) => ({ id: 'v-new', ...c }));

      const result = await service.getOrAdvanceForHandBack('pb-1', null, 'user-1');

      expect(result.status).toBe(ValidationStatus.HUMAN_REVIEW);
    });

    it('leaves an already-ASSIGNED case alone rather than forcing it back to review', async () => {
      const existing = { id: 'v-1', projectBranchId: 'pb-1', status: ValidationStatus.ASSIGNED };
      mockValidationCaseRepo.findOne.mockResolvedValue(existing);

      const result = await service.getOrAdvanceForHandBack('pb-1', null, 'user-1');

      expect(result.status).toBe(ValidationStatus.ASSIGNED);
      expect(mockValidationCaseRepo.save).not.toHaveBeenCalled();
    });
  });
});

