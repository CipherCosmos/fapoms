import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
import { ProjectService } from './project.service';
import { ProjectEntity } from './project.entity';
import { ProjectBranchEntity } from './project-branch.entity';
import { AuditService } from '../../core/audit/audit.service';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { ProjectStatus } from '@fapoms/shared';
import { BranchQueryService } from '../branch/branch-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { AssessmentEntity } from './assessment.entity';
import { ProjectQueryService } from './project-query.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import * as xlsx from 'xlsx';

describe('ProjectService', () => {
  let service: ProjectService;
  let projectRepo: Repository<ProjectEntity>;
  let projectBranchRepo: Repository<ProjectBranchEntity>;

  const mockProjectRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    // Read by allocateProjectNumber to find the highest number in this year's series.
    find: jest.fn().mockResolvedValue([]),
  };

  const mockLiveAssignmentRepo = { findOne: jest.fn().mockResolvedValue(null) };

  const mockProjectBranchRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    // removeProjectBranch reaches the assignment repo through the entity manager to avoid a
    // circular module dependency.
    manager: { getRepository: jest.fn(() => mockLiveAssignmentRepo) },
  };

  const mockAssessmentRepo = {
    findOne: jest.fn(),
    // Preloaded once per import: which branches on this project already have an assessment.
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((dto: any) => dto),
  };

  const mockBranchRepo = {
    findOne: jest.fn(),
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
    recordEvent: jest.fn(), recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); }),
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
          useValue: mockAssessmentRepo,
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
        {
          provide: DataSource,
          useValue: {
            query: jest.fn().mockResolvedValue([]),
          },
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
        { name: 'Project 1', clientId: 'c-1', priority: 'MEDIUM' },
        'user-1',
      );

      expect(result.status).toBe(ProjectStatus.DRAFT);
      expect(mockProjectRepo.save).toHaveBeenCalled();
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });

    /**
     * The number is the system's to give.
     *
     * It was an optional field on the form — blank meant "allocate one", anything typed was
     * honoured. A hand-typed number sits outside the `PRJ-<year>-###` sequence, so the next
     * allocation cannot see it and the series stops being one; and the number is how a project
     * is named in audit entries, document filenames, billing lines and every export.
     */
    it('allocates the number itself, whatever the caller sends', async () => {
      mockProjectRepo.find.mockResolvedValue([{ projectNumber: `PRJ-${new Date().getFullYear()}-007` }]);
      mockProjectRepo.create.mockImplementation((v: any) => v);
      mockProjectRepo.save.mockImplementation(async (v: any) => ({ ...v, id: 'p-2' }));

      // `projectNumber` is not on CreateProjectDto any more; a caller that sends one anyway is
      // refused by the request DTO before this point, and ignored here if it gets through.
      await service.create(
        { name: 'Project 2', clientId: 'c-1', priority: 'MEDIUM', projectNumber: 'HAND-TYPED' } as any,
        'user-1',
      );

      const saved = mockProjectRepo.save.mock.calls.at(-1)![0];
      expect(saved.projectNumber).toBe(`PRJ-${new Date().getFullYear()}-008`);
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException if project is missing', async () => {
      mockProjectRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('p-missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeProjectBranch', () => {
    beforeEach(() => {
      mockLiveAssignmentRepo.findOne.mockResolvedValue(null);
      mockProjectBranchRepo.find.mockResolvedValue([]);
    });

    it('reports a missing branch instead of silently succeeding', async () => {
      // Was wrapped in `if (pb) {}` with no else — a non-existent branch, or one belonging to
      // another project, returned HTTP 200 and a branch list, so the operator believed a
      // removal had happened when nothing was touched.
      mockProjectBranchRepo.findOne.mockResolvedValue(null);

      await expect(service.removeProjectBranch('proj-1', 'missing-pb', 'user-1'))
        .rejects.toThrow(NotFoundException);
      expect(mockProjectBranchRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to unlink a branch that still has live field work on it', async () => {
      mockProjectBranchRepo.findOne.mockResolvedValue({ id: 'pb-1', isActive: true });
      mockLiveAssignmentRepo.findOne.mockResolvedValue({
        assignmentNumber: 'ASN-1', status: 'CHECKED_IN',
      });

      await expect(service.removeProjectBranch('proj-1', 'pb-1', 'user-1'))
        .rejects.toThrow(BadRequestException);
      // The branch must stay active — deactivating it strands the assignment pointing at it.
      expect(mockProjectBranchRepo.save).not.toHaveBeenCalled();
    });

    it('removes a branch with no active assignment', async () => {
      const pb: any = { id: 'pb-1', isActive: true };
      mockProjectBranchRepo.findOne.mockResolvedValue(pb);

      await service.removeProjectBranch('proj-1', 'pb-1', 'user-1');

      expect(mockProjectBranchRepo.save).toHaveBeenCalled();
      expect(pb.isActive).toBe(false);
    });
  });

  describe('generateBranchTemplate', () => {
    beforeEach(() => {
      mockProjectQueryService.findOne.mockResolvedValue({ id: 'p-1', clientId: 'c-1', organizationId: 'o-1' });
    });

    it('asks only for what the operator can know, and says the rest is worked out', async () => {
      mockProjectBranchRepo.find.mockResolvedValue([]);

      const wb = xlsx.read(await service.generateBranchTemplate('p-1'), { type: 'buffer' });

      const branchSheet = wb.Sheets['Branch'];
      const headers = (xlsx.utils.sheet_to_json(branchSheet, { header: 1 })[0] as string[]);
      expect(headers).toEqual([
        'BRANCH', 'BRANCH_NAME', 'DISTRICT', 'STATE', 'Branch Address', 'Packets',
        'Pincode', 'Branch Manager', 'Branch Phone', 'Branch Email',
      ]);

      const instructions = xlsx.utils.sheet_to_json<{ Field: string; Description: string }>(wb.Sheets['Instructions']);
      const fields = instructions.map((r) => r.Field);
      for (const gone of ['Latitude', 'Longitude', 'Risk Category', 'Risk Score', 'Complexity', 'Estimated Hours']) {
        expect(fields).not.toContain(gone);
      }
      // And the operator is told why they are not being asked.
      expect(instructions[0].Field).toBe('Worked out for you');
      expect(instructions[0].Description).toMatch(/priority set on the project/);
    });

    it('prefills existing branches without the derived columns', async () => {
      mockProjectBranchRepo.find.mockResolvedValue([{
        packetCount: 58,
        branch: {
          solId: 'BR-1', name: 'Thenkurissi', district: 'Palakkad', state: 'Kerala',
          address: '1 Main Road', pincode: '678001', latitude: 10.78, longitude: 76.65,
          riskCategory: 'HIGH', complexity: 'STANDARD', estimatedDurationHours: 14.5,
          managerName: 'A. Nair', phone: '9876543210', email: 'b@x.in',
        },
      }]);

      const wb = xlsx.read(await service.generateBranchTemplate('p-1'), { type: 'buffer' });
      const [row] = xlsx.utils.sheet_to_json<Record<string, any>>(wb.Sheets['Branch']);

      expect(row).toEqual({
        BRANCH: 'BR-1', BRANCH_NAME: 'Thenkurissi', DISTRICT: 'Palakkad', STATE: 'Kerala',
        'Branch Address': '1 Main Road', Packets: 58, Pincode: '678001',
        'Branch Manager': 'A. Nair', 'Branch Phone': '9876543210', 'Branch Email': 'b@x.in',
      });
      expect(row).not.toHaveProperty('Latitude');
      expect(row).not.toHaveProperty('Risk Category');
      expect(row).not.toHaveProperty('Estimated Hours');
    });
  });
});
