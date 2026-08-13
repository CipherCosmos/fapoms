import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository, DataSource } from 'typeorm';
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

  const mockClientRepo = {
    findOne: jest.fn(),
  };

  const mockBranchRepo = {
    findOne: jest.fn(),
  };

  const mockBranchService = {
    registerImportedBranch: jest.fn(),
    findOrCreateZone: jest.fn(),
    update: jest.fn(),
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
          useValue: { findOne: jest.fn(), save: jest.fn(), create: jest.fn((dto: any) => dto) },
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

  /**
   * The branch import operators actually use: Projects › upload Excel.
   *
   * Coordinates are always supplied in these fixtures so nothing reaches the geocoder — the
   * behaviour under test is parsing, region canonicalisation and reporting, not geocoding.
   */
  describe('uploadBranchesFromExcel', () => {
    const sheetBuffer = (rows: Record<string, any>[]): Buffer => {
      const ws = xlsx.utils.json_to_sheet(rows);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, 'Branch');
      return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    };

    /** One well-formed row, in the column names the downloadable template uses. */
    const templateRow = (over: Record<string, any> = {}) => ({
      BRANCH: 'BR-1',
      BRANCH_NAME: 'Thenkurissi',
      DISTRICT: 'Palakkad',
      STATE: 'Kerala',
      'Branch Address': '1 Main Road, Palakkad 678001',
      Packets: 40,
      Latitude: 10.7867,
      Longitude: 76.6548,
      ...over,
    });

    beforeEach(() => {
      mockProjectQueryService.findOne.mockResolvedValue({
        id: 'p-1', clientId: 'c-1', organizationId: 'o-1', status: ProjectStatus.PLANNING,
      });
      mockProjectQueryService.findProjectBranches.mockResolvedValue([]);
      mockClientRepo.findOne.mockResolvedValue({ id: 'c-1', planningPreferences: {} });
      mockBranchQueryService.findOneByCode.mockResolvedValue(null);
      mockBranchService.findOrCreateZone.mockResolvedValue({ id: 'z-1' });
      mockBranchService.registerImportedBranch.mockImplementation(async (dto: any) => ({
        id: 'b-new', zoneId: dto.zoneId, ...dto,
      }));
      mockProjectBranchRepo.findOne.mockResolvedValue(null);
      mockProjectBranchRepo.create.mockImplementation((dto: any) => dto);
      mockProjectBranchRepo.save.mockImplementation(async (pb: any) => ({ id: 'pb-1', ...pb }));
    });

    /**
     * The single most damaging bug here: the importer wrote `region: state`, so every branch it
     * ever created carried "Kerala" in a column the whole platform filters as an enum. Each
     * import silently re-broke the column the region migration had just normalised, and the
     * branches were invisible to the operator who owns that territory.
     */
    it('canonicalises the region from the state instead of storing the state name', async () => {
      await service.uploadBranchesFromExcel('p-1', sheetBuffer([templateRow()]), 'user-1');

      expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'SOUTH', state: 'Kerala' }),
        'user-1',
      );
    });

    /**
     * `sheet_to_json` keys rows by the header text verbatim, so an exact `row['Branch Name']`
     * lookup missed `Branch Name ` (trailing space, invisible in Excel) and every other real
     * spelling — dropping every row while still reporting success.
     */
    it('reads columns whatever their casing, spacing or punctuation', async () => {
      const buffer = sheetBuffer([{
        'Branch Code': 'BR-9',
        'branch name ': 'Aundh',
        District: 'Pune',
        State: 'Maharashtra',
        Address: '12 Aundh Road',
        Lat: 18.56,
        Lng: 73.81,
      }]);

      const report = await service.uploadBranchesFromExcel('p-1', buffer, 'user-1');

      expect(report.skipped).toHaveLength(0);
      expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
        expect.objectContaining({ branchCode: 'BR-9', name: 'Aundh', region: 'WEST' }),
        'user-1',
      );
    });

    it('reports the rows it could not use, with their spreadsheet row numbers', async () => {
      const buffer = sheetBuffer([
        templateRow(),
        templateRow({ BRANCH: '', BRANCH_NAME: 'Nameless code' }),
        templateRow({ BRANCH: 'BR-3', STATE: '' }),
      ]);

      const report = await service.uploadBranchesFromExcel('p-1', buffer, 'user-1');

      expect(report.totalRows).toBe(3);
      expect(report.created).toBe(1);
      // Rows 3 and 4 of the sheet — header is row 1.
      expect(report.skipped.map(s => s.row)).toEqual([3, 4]);
      expect(report.skipped[1].reason).toContain('state');
    });

    /**
     * Branch codes are the client's own numbering and collide constantly — every bank has a
     * branch "1". Resolving one without saying whose it is attached another client's branch,
     * with its address and coordinates, to this project.
     */
    it('resolves an existing branch code within this project\'s client', async () => {
      await service.uploadBranchesFromExcel('p-1', sheetBuffer([templateRow()]), 'user-1');

      expect(mockBranchQueryService.findOneByCode).toHaveBeenCalledWith('BR-1', 'c-1');
    });

    /**
     * The template prefills existing branches precisely so a corrected sheet can be sent back,
     * but the only field this path wrote was estimatedDurationHours — a fixed address or a
     * missing region was read and thrown away.
     */
    it('corrects an existing branch from the sheet', async () => {
      mockBranchQueryService.findOneByCode.mockResolvedValue({
        id: 'b-old', name: 'Old Name', address: 'Old address', state: 'Kerala',
        district: 'PALAKKAD', region: null, latitude: null, longitude: null,
      });
      mockBranchService.update.mockImplementation(async (id: string) => ({ id, zoneId: null }));

      const report = await service.uploadBranchesFromExcel('p-1', sheetBuffer([templateRow()]), 'user-1');

      expect(report.updated).toBe(1);
      expect(mockBranchService.update).toHaveBeenCalledWith(
        'b-old',
        expect.objectContaining({
          name: 'Thenkurissi',
          address: '1 Main Road, Palakkad 678001',
          // Backfills a branch that predates region canonicalisation.
          region: 'SOUTH',
          latitude: 10.7867,
        }),
        'user-1',
      );
    });

    it('does not blank fields a sparse correction sheet omits', async () => {
      mockBranchQueryService.findOneByCode.mockResolvedValue({
        id: 'b-old', name: 'Thenkurissi', address: 'Keep me', state: 'Kerala',
        district: 'PALAKKAD', region: 'SOUTH', latitude: 10.7867, longitude: 76.6548,
      });
      mockBranchService.update.mockImplementation(async (id: string) => ({ id, zoneId: null }));

      // Only the code and name — everything else absent.
      const buffer = sheetBuffer([{ BRANCH: 'BR-1', BRANCH_NAME: 'Thenkurissi', STATE: 'Kerala' }]);
      const report = await service.uploadBranchesFromExcel('p-1', buffer, 'user-1');

      // Nothing differs, so nothing is written at all.
      expect(report.updated).toBe(0);
      expect(mockBranchService.update).not.toHaveBeenCalled();
    });

    /**
     * `BranchService.update` re-runs geography validation, which throws when it cannot verify a
     * place — and the curated reference tables cover eight states. Unguarded, one such row threw
     * out of the endpoint as a 500: rows already imported stayed, the rest never ran, and the
     * operator saw a crash with no way to tell how far it got.
     */
    it('keeps importing after a row throws, and names the row that failed', async () => {
      mockBranchService.registerImportedBranch
        .mockRejectedValueOnce(new BadRequestException("Could not verify 'Nowhere' as a real place."))
        .mockImplementation(async (dto: any) => ({ id: 'b-ok', zoneId: dto.zoneId, ...dto }));

      const buffer = sheetBuffer([
        templateRow({ BRANCH: 'BR-BAD', DISTRICT: 'Nowhere' }),
        templateRow({ BRANCH: 'BR-GOOD' }),
      ]);

      const report = await service.uploadBranchesFromExcel('p-1', buffer, 'user-1');

      expect(report.created).toBe(1);
      expect(report.skipped).toEqual([
        { row: 2, branchCode: 'BR-BAD', reason: expect.stringContaining('Nowhere') },
      ]);
    });

    it('refuses a file whose first sheet has no data rows', async () => {
      await expect(service.uploadBranchesFromExcel('p-1', sheetBuffer([]), 'user-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('ignores the blank trailing rows Excel leaves behind', async () => {
      const buffer = sheetBuffer([templateRow(), { BRANCH: '', BRANCH_NAME: '' }]);

      const report = await service.uploadBranchesFromExcel('p-1', buffer, 'user-1');

      expect(report.created).toBe(1);
      expect(report.skipped).toHaveLength(0);
    });
  });
});
