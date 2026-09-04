import { Test, TestingModule } from '@nestjs/testing';
import { PlanningAntiCorruptionLayer } from './planning-acl.adapter';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AssayerService } from '../assayer/assayer.service';

describe('PlanningAntiCorruptionLayer', () => {
  let acl: PlanningAntiCorruptionLayer;

  const mockAssayerService = {
    hydrateWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
    hydrateAllWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue({ assayers: [], total: 0 }),
    findOne: jest.fn().mockResolvedValue({ id: 'asr-1', skills: [], certifications: [], languages: [], specializations: [] }),
  };

  const mockBranchRepo = {};
  const mockAssayerRepo = {
    find: jest.fn().mockResolvedValue([
      // The adapter reads `effectiveLatitude`/`effectiveLongitude` — getters on AssayerEntity
      // that prefer a live GPS fix over the registered home location. This fixture is a plain
      // object, not an entity instance, so the getters don't come along with it and both must
      // be set explicitly or the mapped location silently reads 0,0.
      { id: 'as-1', displayName: 'Vijay Shankar', status: 'ACTIVE', latitude: 19.0, longitude: 72.0, effectiveLatitude: 19.0, effectiveLongitude: 72.0, skills: ['Gold'] },
    ]),
  };
  const mockAssignmentRepo = {
    createQueryBuilder: jest.fn(),
    // No branch is already covered by an active assignment in this fixture.
    find: jest.fn().mockResolvedValue([]),
  };
  const inPlayRegionsQb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    // Default: no in-play region resolvable (empty plannable set), so getAvailableAssayers
    // falls back to the unscoped roster in tests that don't override this.
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  const mockProjectBranchRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'pb-1',
        branch: { id: 'b-1', solId: 'B01', name: 'Pune Central', latitude: 18.5, longitude: 73.8, city: 'Pune', state: 'MH', requiredCompetencies: ['Gold'] },
      },
    ]),
    createQueryBuilder: jest.fn().mockReturnValue(inPlayRegionsQb),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningAntiCorruptionLayer,
        { provide: getRepositoryToken(BranchEntity), useValue: mockBranchRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
        { provide: AssayerService, useValue: mockAssayerService },
      ],
    }).compile();

    acl = module.get<PlanningAntiCorruptionLayer>(PlanningAntiCorruptionLayer);
  });

  it('should map ProjectBranchEntity into PlanningBranch domains', async () => {
    const branches = await acl.getBranchesForPlanning('p-1');
    expect(branches.length).toBe(1);
    expect(branches[0].solId).toBe('B01');
    expect(branches[0].location.latitude).toBe(18.5);
    expect(branches[0].requiredSkills.has('Gold')).toBe(true);
  });

  it('should map AssayerEntity into PlanningAssayer domains', async () => {
    const assayers = await acl.getAvailableAssayers(new Date());
    expect(assayers.length).toBe(1);
    expect(assayers[0].displayName).toBe('Vijay Shankar');
    expect(assayers[0].location.latitude).toBe(19.0);
  });

  /**
   * getAvailableAssayers used to load the entire national roster whenever the caller had no
   * scope.regions (a national desk, or no scope at all). It now falls back to the regions of
   * branches actually still awaiting coverage, and only loads the whole roster when even that
   * can't be resolved.
   */
  describe('getAvailableAssayers region scoping', () => {
    it('uses the caller-supplied scope regions directly, without touching in-play regions', async () => {
      mockAssayerRepo.find.mockClear();
      inPlayRegionsQb.getRawMany.mockClear();

      await acl.getAvailableAssayers(new Date(), { regions: ['NORTH'] as any });

      expect(mockAssayerRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ region: expect.anything() }) }),
      );
      expect(inPlayRegionsQb.getRawMany).not.toHaveBeenCalled();
    });

    it('falls back to the regions of still-plannable branches when the caller has no scope', async () => {
      mockAssayerRepo.find.mockClear();
      inPlayRegionsQb.getRawMany.mockResolvedValueOnce([{ region: 'SOUTH' }, { region: 'WEST' }]);

      await acl.getAvailableAssayers(new Date());

      expect(inPlayRegionsQb.getRawMany).toHaveBeenCalled();
      const call = mockAssayerRepo.find.mock.calls[0][0];
      expect(call.where.region).toBeDefined();
    });

    it('falls back to the full national roster only when no in-play region can be resolved', async () => {
      mockAssayerRepo.find.mockClear();
      inPlayRegionsQb.getRawMany.mockResolvedValueOnce([]);

      await acl.getAvailableAssayers(new Date());

      const call = mockAssayerRepo.find.mock.calls[0][0];
      expect(call.where.region).toBeUndefined();
    });
  });

  /**
   * The coverage planner hard-filters candidates on this number. It used to load every
   * assignment with isActive = true and no status filter, and since terminal states keep
   * isActive set, delivered, rejected and cancelled work counted as current load — one assayer
   * read 15 of 16 while holding no committed work at all, and was one branch from being
   * silently dropped from every plan.
   */
  describe('getAssayerCurrentWorkloads', () => {
    it('counts only committed work, and asks the database to do the counting', async () => {
      const qb: any = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ assayerId: 'as-1', count: '2' }]),
      };
      mockAssignmentRepo.createQueryBuilder.mockReturnValue(qb);

      const counts = await acl.getAssayerCurrentWorkloads(['as-1', 'as-2']);

      expect(counts).toEqual({ 'as-1': 2 });
      // as-2 has no committed work and must be absent rather than inheriting someone's count.
      expect(counts['as-2']).toBeUndefined();

      const statusFilter = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes('status'));
      expect(statusFilter).toBeDefined();
      expect(statusFilter[1].statuses).toEqual(['ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS']);
      expect(statusFilter[1].statuses).not.toContain('COMPLETED');
      expect(statusFilter[1].statuses).not.toContain('PENDING');
    });

    it('returns nothing without querying when asked about no assayers', async () => {
      mockAssignmentRepo.createQueryBuilder.mockClear();
      await expect(acl.getAssayerCurrentWorkloads([])).resolves.toEqual({});
      expect(mockAssignmentRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

});
