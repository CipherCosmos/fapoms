import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Repository, DataSource, In } from 'typeorm';
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
import { GeoPrecisionService } from '../geo/geo-precision.service';
import * as xlsx from 'xlsx';

/**
 * The geocoder, stubbed at the module boundary.
 *
 * The template no longer asks for Latitude/Longitude, so the common case is now a row with
 * neither — and until this mock existed no test reached `getRealCoordinates` at all (every
 * fixture supplied a pair). A stable pincode-tier answer lets the no-coordinates path be asserted
 * without touching the network or the on-disk geo cache.
 */
jest.mock('../geo/india-geocoder', () => ({
  geocodeIndiaRobust: jest.fn(async () => ({
    lat: 10.78, lng: 76.65, accuracyMeters: 2500, source: 'pincode', matchedName: 'Palakkad 678001',
  })),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { geocodeIndiaRobust: mockGeocode } = require('../geo/india-geocoder') as { geocodeIndiaRobust: jest.Mock };

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

  const mockClientRepo = {
    findOne: jest.fn(),
  };

  // The precision hand-off at the end of an import. Resolved, never awaited by the importer.
  const mockGeoPrecision = { enqueueBackfill: jest.fn().mockResolvedValue(undefined) };

  const mockAssessmentRepo = {
    findOne: jest.fn(),
    // Preloaded once per import: which branches on this project already have an assessment.
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((dto: any) => dto),
  };

  const mockBranchRepo = {
    findOne: jest.fn(),
    // The importer resolves every branch code in a file with one `In(codes)` query rather than a
    // `findOneByCode` per row, so the upload specs drive this rather than the query service.
    find: jest.fn(),
  };

  const mockBranchService = {
    registerImportedBranch: jest.fn(),
    // Reviving an archived branch is a named act with its own audit event, not an `isActive` field
    // on the edit DTO — see `BranchService.restoreArchived`.
    restoreArchived: jest.fn(async (id: string) => ({ id, isActive: true })),
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
          useValue: mockAssessmentRepo,
        },
        {
          provide: getRepositoryToken(BranchEntity),
          useValue: mockBranchRepo,
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
          provide: GeoPrecisionService,
          useValue: mockGeoPrecision,
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
      // `organizationId` is on ClientEntity and is where a client-scoped import gets it from —
      // a project import reads the project's copy instead.
      mockClientRepo.findOne.mockResolvedValue({ id: 'c-1', organizationId: 'o-1', planningPreferences: {} });
      // Nothing in the branch master, no branches on the project, no assessments — the three
      // batched reads the importer now issues once for the whole file instead of once per row.
      mockBranchRepo.find.mockResolvedValue([]);
      mockProjectBranchRepo.find.mockResolvedValue([]);
      mockAssessmentRepo.find.mockResolvedValue([]);
      mockBranchService.findOrCreateZone.mockResolvedValue({ id: 'z-1' });
      mockBranchService.registerImportedBranch.mockImplementation(async (dto: any) => ({
        id: 'b-new', zoneId: dto.zoneId, ...dto,
      }));
      mockProjectBranchRepo.create.mockImplementation((dto: any) => dto);
      mockProjectBranchRepo.save.mockImplementation(async (pb: any) => ({ id: 'pb-1', ...pb }));
    });

    /**
     * The same file, uploaded on the Branches page instead of a project.
     *
     * This is what the second importer used to do — `BranchService.importExcel`, 200 lines that
     * geocoded, checked geography and looked up the existing branch **per row inside the HTTP
     * request**. It is deleted; a client-scoped import is now the same code as a project one with
     * the linking half switched off. These tests pin that "switched off" means exactly two things
     * — no project-branch row and no assessment — and nothing else.
     */
    /**
     * The duplicate a re-import used to create.
     *
     * The prefetch filtered `isActive: true`, so an archived branch was invisible and the importer
     * created a *second* branch with the same client and SOL ID beside it. The database allows it —
     * `UQ_branches_client_sol_id` is `WHERE is_active = true` — and no later import can tell the two
     * apart, while one of them holds all the history. Matching archived rows and restoring them is
     * also what the assayer roster importer already does, for the same stated reason.
     */
    describe('a branch the file still names, but which was archived', () => {
      const archived = {
        id: 'b-old', solId: 'BR-1', name: 'Thenkurissi', isActive: false,
        state: 'Kerala', district: 'Palakkad', address: '1 Main Road, Palakkad 678001',
        latitude: 10.7867, longitude: 76.6548, estimatedDurationHours: 10, region: 'SOUTH',
      };

      beforeEach(() => {
        mockBranchRepo.find.mockResolvedValue([archived]);
        mockBranchService.update.mockImplementation(async (_id: string, patch: any) => ({ ...archived, ...patch }));
      });

      it('restores it instead of creating a twin', async () => {
        await service.uploadBranchesFromExcel({ kind: 'CLIENT', id: 'c-1' }, sheetBuffer([templateRow()]), 'user-1');

        expect(mockBranchService.restoreArchived).toHaveBeenCalledWith('b-old', 'user-1');
        // The twin: a second create for a SOL ID that already exists on this client.
        expect(mockBranchService.registerImportedBranch).not.toHaveBeenCalled();
      });

      it('tells the operator their file brought a branch back', async () => {
        const report = await service.uploadBranchesFromExcel(
          { kind: 'CLIENT', id: 'c-1' }, sheetBuffer([templateRow()]), 'user-1',
        );

        expect(report.revived).toHaveLength(1);
        expect(report.revived[0]).toMatchObject({ solId: 'BR-1' });
        expect(report.revived[0].reason).toMatch(/archived/i);
        expect(report.created).toBe(0);
      });

      it('leaves an active branch alone — nothing to restore', async () => {
        mockBranchRepo.find.mockResolvedValue([{ ...archived, isActive: true }]);

        const report = await service.uploadBranchesFromExcel(
          { kind: 'CLIENT', id: 'c-1' }, sheetBuffer([templateRow()]), 'user-1',
        );

        expect(mockBranchService.restoreArchived).not.toHaveBeenCalled();
        expect(report.revived).toEqual([]);
      });
    });

    describe('scope: CLIENT — the branch master, with no project', () => {
      const CLIENT_SCOPE = { kind: 'CLIENT' as const, id: 'c-1' };

      it('writes the branch, with the client and organisation taken from the client', async () => {
        await service.uploadBranchesFromExcel(CLIENT_SCOPE, sheetBuffer([templateRow()]), 'user-1');

        expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
          expect.objectContaining({ clientId: 'c-1', organizationId: 'o-1', region: 'SOUTH' }),
          'user-1',
        );
      });

      it('creates no project-branch link and no assessment', async () => {
        await service.uploadBranchesFromExcel(CLIENT_SCOPE, sheetBuffer([templateRow()]), 'user-1');

        expect(mockProjectBranchRepo.save).not.toHaveBeenCalled();
        expect(mockAssessmentRepo.save).not.toHaveBeenCalled();
      });

      it('reports linked: 0 and an empty branch list, not the project shape', async () => {
        const report = await service.uploadBranchesFromExcel(
          CLIENT_SCOPE, sheetBuffer([templateRow()]), 'user-1',
        );

        expect(report.created).toBe(1);
        expect(report.linked).toBe(0);
        expect(report.branches).toEqual([]);
      });

      /**
       * A project-scoped import 404s on an unknown project; a client-scoped one has to do the
       * same for an unknown client rather than accept the file and fail inside a job.
       */
      it('refuses an unknown client up front', async () => {
        mockClientRepo.findOne.mockResolvedValue(null);

        await expect(
          service.uploadBranchesFromExcel({ kind: 'CLIENT', id: 'ghost' }, sheetBuffer([templateRow()]), 'user-1'),
        ).rejects.toThrow(NotFoundException);
      });

      /**
       * Every row-level rule is shared with the project path, so a rule proved on one holds on the
       * other. Skip reporting is the one that used to differ most: the deleted importer returned
       * `string[]` messages with no row numbers, so a 3,759-row file reported "Row 12: ..." as
       * free text nothing could group or resolve.
       */
      it('reports an unusable row with its spreadsheet row number, as the project path does', async () => {
        const report = await service.uploadBranchesFromExcel(
          CLIENT_SCOPE,
          sheetBuffer([templateRow(), templateRow({ BRANCH: '', BRANCH_NAME: '' })]),
          'user-1',
        );

        expect(report.created).toBe(1);
        expect(report.totalRows).toBe(2);
      });
    });

    /**
     * The single most damaging bug here: the importer wrote `region: state`, so every branch it
     * ever created carried "Kerala" in a column the whole platform filters as an enum. Each
     * import silently re-broke the column the region migration had just normalised, and the
     * branches were invisible to the operator who owns that territory.
     */
    it('canonicalises the region from the state instead of storing the state name', async () => {
      await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([templateRow()]), 'user-1');

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

      const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

      expect(report.skipped).toHaveLength(0);
      expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
        expect.objectContaining({ solId: 'BR-9', name: 'Aundh', region: 'WEST' }),
        'user-1',
      );
    });

    /**
     * The two branch importers — this one and the Branches page — must key identity the same way,
     * or a file uploaded through both doors inserts a second copy of every branch. Both key on the
     * SOL id, read from the "BRANCH"/"Branch Code" column when there is no separate SOL column, so
     * the two paths agree and a re-upload matches.
     */
    it('reads the SOL id from the "BRANCH" column when the file has no SOL column', async () => {
      await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([templateRow()]), 'user-1');

      expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
        expect.objectContaining({ solId: 'BR-1' }),
        'user-1',
      );
    });

    it('prefers an explicit SOL column when the file provides one', async () => {
      await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([templateRow({ 'SOL ID': 'S-77' })]), 'user-1');

      expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
        expect.objectContaining({ solId: 'S-77' }),
        'user-1',
      );
    });

    it('matches an existing branch by its SOL id and updates it instead of creating a duplicate', async () => {
      const existing = {
        id: 'b-existing', solId: 'S-77', name: 'Old name',
        clientId: 'c-1', latitude: 10.7867, longitude: 76.6548, region: 'SOUTH',
      };
      // The importer queries the master by SOL id; this branch shares that SOL id with the sheet.
      mockBranchRepo.find.mockImplementation(async (opts: any) => (opts?.where?.solId ? [existing] : []));
      mockBranchService.update.mockImplementation(async (id: string, patch: any) => ({ ...existing, id, ...patch }));

      const report = await service.uploadBranchesFromExcel(
        { kind: 'PROJECT', id: 'p-1' }, sheetBuffer([templateRow({ 'SOL ID': 'S-77' })]), 'user-1',
      );

      expect(mockBranchService.registerImportedBranch).not.toHaveBeenCalled();
      expect(report.created).toBe(0);
    });

    it('reports the rows it could not use, with their spreadsheet row numbers', async () => {
      const buffer = sheetBuffer([
        templateRow(),
        templateRow({ BRANCH: '', BRANCH_NAME: 'Nameless code' }),
        templateRow({ BRANCH: 'BR-3', STATE: '' }),
      ]);

      const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

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
    it('resolves existing branch codes within this project\'s client, in one query for the file', async () => {
      const buffer = sheetBuffer([templateRow(), templateRow({ BRANCH: 'BR-2' }), templateRow({ BRANCH: 'BR-3' })]);

      await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

      /**
       * Two things at once, and both matter.
       *
       * The client scope: branch codes are the client's own numbering and collide constantly —
       * every bank has a branch "1" — so an unscoped lookup attached another client's branch,
       * with its address and coordinates, to this project.
       *
       * The batching: this was one `findOneByCode` per row, so a 2,000-branch file issued 2,000
       * queries to answer a question one `In(codes)` answers. Asserting the call count is the
       * only way that stays true — a future edit that puts the lookup back inside the loop still
       * passes every behavioural test in this file.
       *
       * And deliberately NO `isActive` filter. It had one, and that is how a re-import produced
       * duplicates: an archived branch was invisible here, so the importer created a second row
       * with the same client and SOL ID beside it — permitted by the database, because
       * `UQ_branches_client_sol_id` is `WHERE is_active = true`, and indistinguishable to every
       * later import. Archived rows are matched and restored instead; see the "still names, but
       * which was archived" block above.
       */
      expect(mockBranchRepo.find).toHaveBeenCalledTimes(1);
      expect(mockBranchRepo.find).toHaveBeenCalledWith({
        where: expect.not.objectContaining({ isActive: expect.anything() }),
      });
      expect(mockBranchRepo.find).toHaveBeenCalledWith({
        where: expect.objectContaining({
          solId: In(['BR-1', 'BR-2', 'BR-3']),
          clientId: 'c-1',
        }),
      });
    });

    /**
     * The zone lookups were the other per-row read: `resolveZoneName` loads every zone the client
     * can see and scans it, then `findOrCreateZone` issues its own query — 2,000 rows in one
     * state ran 4,000 queries to reach one answer.
     */
    it('resolves a zone once per state, not once per row', async () => {
      const buffer = sheetBuffer([
        templateRow({ BRANCH: 'BR-1' }),
        templateRow({ BRANCH: 'BR-2' }),
        templateRow({ BRANCH: 'BR-3', STATE: 'Maharashtra', DISTRICT: 'Pune' }),
      ]);

      await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

      // Two distinct states across three rows.
      expect(mockBranchService.findOrCreateZone).toHaveBeenCalledTimes(2);
    });

    /**
     * The template prefills existing branches precisely so a corrected sheet can be sent back,
     * but the only field this path wrote was estimatedDurationHours — a fixed address or a
     * missing region was read and thrown away.
     */
    it('corrects an existing branch from the sheet', async () => {
      mockBranchRepo.find.mockResolvedValue([{
        id: 'b-old', solId: 'BR-1', name: 'Old Name', address: 'Old address', state: 'Kerala',
        district: 'PALAKKAD', region: null, latitude: null, longitude: null,
      }]);
      mockBranchService.update.mockImplementation(async (id: string) => ({ id, zoneId: null }));

      const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([templateRow()]), 'user-1');

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
      mockBranchRepo.find.mockResolvedValue([{
        id: 'b-old', solId: 'BR-1', name: 'Thenkurissi', address: 'Keep me', state: 'Kerala',
        district: 'PALAKKAD', region: 'SOUTH', latitude: 10.7867, longitude: 76.6548,
      }]);
      mockBranchService.update.mockImplementation(async (id: string) => ({ id, zoneId: null }));

      // Only the code and name — everything else absent.
      const buffer = sheetBuffer([{ BRANCH: 'BR-1', BRANCH_NAME: 'Thenkurissi', STATE: 'Kerala' }]);
      const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

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

      const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

      expect(report.created).toBe(1);
      expect(report.skipped).toEqual([
        { row: 2, solId: 'BR-BAD', reason: expect.stringContaining('Nowhere') },
      ]);
    });

    it('refuses a file whose first sheet has no data rows', async () => {
      await expect(service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([]), 'user-1'))
        .rejects.toThrow(BadRequestException);
    });

    it('ignores the blank trailing rows Excel leaves behind', async () => {
      const buffer = sheetBuffer([templateRow(), { BRANCH: '', BRANCH_NAME: '' }]);

      const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, buffer, 'user-1');

      expect(report.created).toBe(1);
      expect(report.skipped).toHaveLength(0);
    });

    /**
     * The six columns an operator was asked for and never knew — Latitude, Longitude, Risk
     * Category, Risk Score, Complexity, Estimated Hours — are gone from the template and are
     * derived by the importer instead. These cases pin down what "derived" means.
     */
    describe('derives what the sheet no longer asks for', () => {
      /** A row shaped like the new template: no coordinates, no risk, no complexity, no hours. */
      const plainRow = (over: Record<string, any> = {}) => {
        const { Latitude: _lat, Longitude: _lng, ...rest } = templateRow(over);
        return rest;
      };

      beforeEach(() => {
        mockGeocode.mockClear();
        mockProjectQueryService.findOne.mockResolvedValue({
          id: 'p-1', clientId: 'c-1', organizationId: 'o-1', status: ProjectStatus.PLANNING,
          priority: Priority.HIGH,
        });
      });

      it('locates a branch from its address when no coordinates are supplied', async () => {
        const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow()]), 'user-1');

        expect(report.created).toBe(1);
        expect(mockGeocode).toHaveBeenCalledTimes(1);
        expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
          expect.objectContaining({
            latitude: 10.78, longitude: 76.65, geoSource: 'pincode', geoAccuracyMeters: 2500,
            geoMatchedName: 'Palakkad 678001',
          }),
          'user-1',
        );
      });

      it('hands coarsely placed branches to the precision worker when the import finishes', async () => {
        // The stub geocoder answers at the pincode tier (2.5 km) — below the "needs a better fix"
        // threshold — so first prove the clean case enqueues nothing…
        mockGeoPrecision.enqueueBackfill.mockClear();
        await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow()]), 'user-1');
        expect(mockGeoPrecision.enqueueBackfill).toHaveBeenCalledWith('branch', [], expect.stringContaining('p-1'));

        // …then a district-centroid placement (15 km), which is the common real outcome.
        mockGeoPrecision.enqueueBackfill.mockClear();
        mockGeocode.mockResolvedValueOnce({ lat: 10.7, lng: 76.6, accuracyMeters: 15000, source: 'locality' });
        const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow()]), 'user-1');

        expect(report.imprecise).toHaveLength(1);
        expect(report.imprecise[0].reason).toMatch(/precise lookup is queued/);
        expect(mockGeoPrecision.enqueueBackfill).toHaveBeenCalledWith('branch', ['b-new'], expect.stringContaining('p-1'));
      });

      it('still honours a coordinate pair a sheet happens to carry, and skips the geocoder for it', async () => {
        await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([templateRow()]), 'user-1');

        expect(mockGeocode).not.toHaveBeenCalled();
        expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
          expect.objectContaining({ latitude: 10.7867, longitude: 76.6548 }),
          'user-1',
        );
      });

      it("takes the branch's risk from the project's priority, and scores it so the planner's senior-assayer rule can fire", async () => {
        await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow()]), 'user-1');

        expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
          // HIGH → 7, the threshold the recommendation engine reads as "send someone senior".
          expect.objectContaining({ riskCategory: 'HIGH', riskScore: 7 }),
          'user-1',
        );
      });

      it('carries the project priority onto the project_branch row, which assignments inherit', async () => {
        await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow()]), 'user-1');

        expect(mockProjectBranchRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ priority: Priority.HIGH }),
        );
      });

      it('rates complexity from packet volume', async () => {
        const cases: Array<[number, string]> = [
          [16, 'SIMPLE'], [40, 'SIMPLE'], [41, 'STANDARD'], [100, 'STANDARD'], [101, 'COMPLEX'], [161, 'COMPLEX'],
        ];
        for (const [packets, expected] of cases) {
          mockBranchService.registerImportedBranch.mockClear();
          await service.uploadBranchesFromExcel(
            { kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow({ BRANCH: `BR-${packets}`, Packets: packets })]), 'user-1',
          );
          expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
            expect.objectContaining({ complexity: expected }),
            'user-1',
          );
        }
      });

      it('falls back to STANDARD complexity and 6 hours when no packets are recorded', async () => {
        await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow({ Packets: '' })]), 'user-1');

        expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
          expect.objectContaining({ complexity: 'STANDARD', estimatedDurationHours: 6.0 }),
          'user-1',
        );
      });

      it('ignores Risk Category, Risk Score, Complexity and Estimated Hours if a sheet still carries them', async () => {
        // A legacy sheet — or a hand-edited one — with values that contradict every derivation.
        const row = plainRow({
          Packets: 16, // → SIMPLE
          'Risk Category': 'CRITICAL', 'Risk Score': 9, Complexity: 'COMPLEX', 'Estimated Hours': 99,
        });
        await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([row]), 'user-1');

        expect(mockBranchService.registerImportedBranch).toHaveBeenCalledWith(
          expect.objectContaining({
            riskCategory: 'HIGH', riskScore: 7,      // from the project, not the sheet
            complexity: 'SIMPLE',                     // from packets, not the sheet
            estimatedDurationHours: 4,                // 16 × 15 / 60, not the sheet's 99
          }),
          'user-1',
        );
      });

      it('re-derives complexity and hours on re-import when packets change, but never risk', async () => {
        mockBranchRepo.find.mockResolvedValue([{
          id: 'b-old', solId: 'BR-1', name: 'Thenkurissi', address: '1 Main Road, Palakkad 678001',
          state: 'Kerala', district: 'PALAKKAD', region: 'SOUTH', latitude: 10.7867, longitude: 76.6548,
          // Ops escalated this one by hand — a re-import must leave it alone.
          riskCategory: 'CRITICAL', riskScore: 9, complexity: 'SIMPLE', estimatedDurationHours: 10,
        }]);
        mockBranchService.update.mockImplementation(async (id: string) => ({ id, zoneId: null }));

        // This cycle the branch has far more packets.
        const report = await service.uploadBranchesFromExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer([plainRow({ Packets: 140 })]), 'user-1');

        expect(report.updated).toBe(1);
        const [, patch] = mockBranchService.update.mock.calls[0];
        expect(patch).toEqual(expect.objectContaining({ complexity: 'COMPLEX', estimatedDurationHours: 35 }));
        expect(patch).not.toHaveProperty('riskCategory');
        expect(patch).not.toHaveProperty('riskScore');
      });
    });

    /**
     * What the preflight counts decides whether the operator waits or is sent to a status URL.
     * It used to count "rows without a Latitude column" — a fair proxy until the template stopped
     * asking for coordinates, after which every row looked like a lookup. A re-import of 72
     * unchanged branches was deferred to a background job that ran zero geocodes in one second.
     */
    describe('preflight — counts the lookups that will actually happen', () => {
      const preflight = (rows: Record<string, any>[]) =>
        service.preflightBranchExcel({ kind: 'PROJECT', id: 'p-1' }, sheetBuffer(rows));

      /** A row shaped like the current template: no coordinate columns at all. */
      const noCoords = (over: Record<string, any> = {}) => {
        const { Latitude: _lat, Longitude: _lng, ...rest } = templateRow(over);
        return rest;
      };

      beforeEach(() => {
        mockProjectQueryService.findOne.mockResolvedValue({ id: 'p-1', clientId: 'c-1', organizationId: 'o-1' });
      });

      it('counts every row when the branches are new to this client', async () => {
        mockBranchRepo.find.mockResolvedValue([]);

        const result = await preflight([noCoords({ BRANCH: 'NEW-1' }), noCoords({ BRANCH: 'NEW-2' })]);

        expect(result.rowsNeedingGeocode).toBe(2);
      });

      it('counts nothing when every branch is already known and has not moved', async () => {
        mockBranchRepo.find.mockResolvedValue([
          { solId: 'BR-1', address: '1 Main Road, Palakkad 678001', district: 'PALAKKAD', state: 'Kerala' },
        ]);

        const result = await preflight([noCoords()]);

        // The whole point: this import runs in the request in milliseconds, so the operator is
        // never told to go and watch a job that has already finished.
        expect(result.rowsNeedingGeocode).toBe(0);
        expect(result.totalRows).toBe(1);
      });

      it('counts a known branch again once its address moves', async () => {
        mockBranchRepo.find.mockResolvedValue([
          { solId: 'BR-1', address: 'The old address', district: 'PALAKKAD', state: 'Kerala' },
        ]);

        const result = await preflight([noCoords()]);

        expect(result.rowsNeedingGeocode).toBe(1);
      });

      it('counts a known branch again when its district or state is corrected', async () => {
        mockBranchRepo.find.mockResolvedValue([
          { solId: 'BR-1', address: '1 Main Road, Palakkad 678001', district: 'THRISSUR', state: 'Kerala' },
        ]);

        await expect(preflight([noCoords()])).resolves.toMatchObject({ rowsNeedingGeocode: 1 });
      });

      it('never counts a row that carries its own coordinates', async () => {
        mockBranchRepo.find.mockResolvedValue([]);

        // templateRow still supplies Latitude/Longitude — a client export may carry them.
        const result = await preflight([templateRow({ BRANCH: 'NEW-9' })]);

        expect(result.rowsNeedingGeocode).toBe(0);
      });
    });

  });

  describe('generateBranchTemplate', () => {
    beforeEach(() => {
      mockProjectQueryService.findOne.mockResolvedValue({ id: 'p-1', clientId: 'c-1', organizationId: 'o-1' });
      mockClientRepo.findOne.mockResolvedValue({ id: 'c-1' });
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
