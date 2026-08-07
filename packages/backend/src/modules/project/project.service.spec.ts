import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ProjectService } from './project.service';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { BranchEntity } from '../branch/branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { ProjectStatus, Priority } from '@fapoms/shared';
import { ClientEntity } from '../client/client.entity';
import { BranchService } from '../branch/branch.service';
import { BranchQueryService } from '../branch/branch-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { AssessmentEntity } from './assessment.entity';
import { ProjectQueryService } from './project-query.service';
import { ZoneEntity } from '../zone/zone.entity';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';

describe('ProjectService', () => {
  let service: ProjectService;
  let projectRepo: Repository<ProjectEntity>;
  let projectBranchRepo: Repository<ProjectBranchEntity>;

  const mockProjectRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };

  const mockProjectBranchRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  const mockClientRepo = {
    findOne: jest.fn(),
  };

  const mockBranchRepo = {
    findOne: jest.fn(),
  };

  const mockBranchService = {
    registerImportedBranch: jest.fn(),
    findOrCreateZone: jest.fn(),
  };

  const mockBranchQueryService = {
    findOne: mockBranchRepo.findOne,
    findOneByCode: jest.fn(),
  };

  const mockProjectQueryService = {
    findOne: jest.fn().mockImplementation((id) => {
      if (id === 'non-existent-id' || id === 'p-missing') {
        throw new NotFoundException(`Project ${id} not found.`);
      }
      return Promise.resolve({ id, status: ProjectStatus.DRAFT, name: 'Project 1' });
    }),
    findAll: jest.fn().mockResolvedValue({ projects: [], total: 0 }),
    findProjectBranches: jest.fn().mockResolvedValue([]),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  const mockWorkflowEngine = {
    registerWorkflow: jest.fn(),
    executeTransition: jest.fn(),
    executeCommand: jest.fn().mockImplementation((key, id, cmd, from, to, uid, role, roles, action) => action()),
  };

  const mockDomainEventPublisher = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectService,
        {
          provide: getRepositoryToken(ProjectEntity),
          useValue: mockProjectRepo,
        },
        {
          provide: getRepositoryToken(ProjectBranchEntity),
          useValue: mockProjectBranchRepo,
        },
        {
          provide: getRepositoryToken(AssessmentEntity),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(ClientEntity),
          useValue: mockClientRepo,
        },
        {
          provide: getRepositoryToken(ZoneEntity),
          useValue: { createQueryBuilder: jest.fn(() => ({ where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), getMany: jest.fn().mockResolvedValue([]) })), find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined), emitSafe: jest.fn() },
        },
        {
          provide: BranchQueryService,
          useValue: mockBranchQueryService,
        },
        {
          provide: BranchService,
          useValue: mockBranchService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide: WorkflowEngine,
          useValue: mockWorkflowEngine,
        },
        {
          provide: DomainEventPublisher,
          useValue: mockDomainEventPublisher,
        },
        {
          provide: ProjectQueryService,
          useValue: mockProjectQueryService,
        },
      ],
    }).compile();

    service = module.get<ProjectService>(ProjectService);
    projectRepo = module.get<Repository<ProjectEntity>>(getRepositoryToken(ProjectEntity));
    projectBranchRepo = module.get<Repository<ProjectBranchEntity>>(getRepositoryToken(ProjectBranchEntity));

    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should successfully create a project in DRAFT status', async () => {
      const mockCreated = {
        id: 'p-1',
        projectNumber: 'PROJ-1',
        name: 'Project 1',
        status: ProjectStatus.DRAFT,
      };
      mockProjectRepo.create.mockReturnValue(mockCreated);
      mockProjectRepo.save.mockResolvedValue(mockCreated);

      const result = await service.create(
        {
          name: 'Project 1',
          projectNumber: 'PROJ-1',
          clientId: 'c-1',
          priority: 'MEDIUM',
        },
        'user-1',
      );

      expect(result.status).toBe(ProjectStatus.DRAFT);
      expect(mockProjectRepo.save).toHaveBeenCalled();
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException if project is missing', async () => {
      mockProjectRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('p-missing')).rejects.toThrow(NotFoundException);
    });
  });
});
