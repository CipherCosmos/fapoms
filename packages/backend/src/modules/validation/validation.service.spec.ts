import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ValidationService } from './validation.service';
import { ValidationCaseEntity } from './validation-case.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { ValidationStatus } from '@fapoms/shared';

describe('ValidationService', () => {
  let service: ValidationService;
  let validationCaseRepo: Repository<ValidationCaseEntity>;
  let projectBranchRepo: Repository<ProjectBranchEntity>;

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

  const mockAuditService = {
    recordEvent: jest.fn(),
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
          provide: getRepositoryToken(ProjectBranchEntity),
          useValue: mockProjectBranchRepo,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
      ],
    }).compile();

    service = module.get<ValidationService>(ValidationService);
    validationCaseRepo = module.get<Repository<ValidationCaseEntity>>(getRepositoryToken(ValidationCaseEntity));
    projectBranchRepo = module.get<Repository<ProjectBranchEntity>>(getRepositoryToken(ProjectBranchEntity));

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
