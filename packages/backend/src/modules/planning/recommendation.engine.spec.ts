import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AssignmentStatus } from '@fapoms/shared';
import {
  RecommendationEngine,
  AvailabilityFilter,
  ConsecutiveBranchAuditFilter,
  ClientRestrictionFilter,
  ClientEligibilityFilter,
  RuleEngineEligibilityFilter,
  RequiredSkillsFilter,
  DistanceScoreCalculator,
  TravelTimeScoreCalculator,
  WorkloadScoreCalculator,
  PerformanceScoreCalculator,
  RejectionAcceptanceScoreCalculator,
  DeliverySpeedScoreCalculator,
  QueryVolumeScoreCalculator,
  ExperienceScoreCalculator,
  CostScoreCalculator,
  ClientPreferenceScoreCalculator,
  BranchFamiliarityScoreCalculator,
  SLAComplianceScoreCalculator,
  CustomerDensityScoreCalculator,
  ProfitabilityScoreCalculator,
  RiskScoreCalculator,
} from './recommendation.engine';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { RoutingService } from '../geo/routing.provider';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { RuleEngine } from '../platform/rules/rule.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';
import { ConstraintEvaluator } from './constraint.evaluator';
import { AssayerService } from '../assayer/assayer.service';
import { HolidayService } from '../holiday/holiday.service';
import { ScheduleEntity } from '../scheduling/schedule.entity';
import { ValidationQueryEntity } from '../validation-query/validation-query.entity';

describe('RecommendationEngine', () => {
  let engine: RecommendationEngine;

  /** Grouped-count query builder shape used by the engine's fact resolution. */
  const groupedCountBuilder = () => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  });


  const mockAssayerService = {
    hydrateWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
    hydrateAllWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue({ assayers: [], total: 0 }),
    findOne: jest.fn().mockResolvedValue({ id: 'asr-1', skills: [], certifications: [], languages: [], specializations: [] }),
  };

  const mockHolidayService = {
    isHoliday: jest.fn().mockResolvedValue(false),
    findAll: jest.fn().mockResolvedValue({ holidays: [], total: 0 }),
  };

  const mockAssayerRepo = {
    find: jest.fn(),
  };

  const mockAssignmentRepo = {
    findOne: jest.fn(),
    count: jest.fn(),
    find: jest.fn(),
    /**
     * recommend() now resolves committed workload for the whole candidate pool in one grouped
     * count instead of one count per assayer. Returning an empty set here means "nobody has
     * committed work", which is what these fixtures already assumed.
     */
    createQueryBuilder: jest.fn(groupedCountBuilder),
  };

  const mockCommercialRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
  };

  const mockQueryRepo = {
    count: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn(groupedCountBuilder),
  };

  const mockClientRepo = {
    findOne: jest.fn(),
  };

  const mockProjectBranchRepo = {
    findOne: jest.fn(),
  };

  const mockRoutingService = {
    calculateRoute: jest.fn(),
  };

  const mockRuleEngine = {
    evaluate: jest.fn().mockResolvedValue([{ passed: true, actionType: 'ALERT' }]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationEngine,
        AvailabilityFilter,
        ConsecutiveBranchAuditFilter,
        ClientRestrictionFilter,
        ClientEligibilityFilter,
        RuleEngineEligibilityFilter,
        RequiredSkillsFilter,
        DistanceScoreCalculator,
        TravelTimeScoreCalculator,
        WorkloadScoreCalculator,
        PerformanceScoreCalculator,
        RejectionAcceptanceScoreCalculator,
        DeliverySpeedScoreCalculator,
        QueryVolumeScoreCalculator,
        ExperienceScoreCalculator,
        CostScoreCalculator,
        ClientPreferenceScoreCalculator,
        BranchFamiliarityScoreCalculator,
        SLAComplianceScoreCalculator,
        CustomerDensityScoreCalculator,
        ProfitabilityScoreCalculator,
        RiskScoreCalculator,
        ConfigurationResolver,
        ConstraintEvaluator,
        {
          provide: getRepositoryToken(AssayerEntity),
          useValue: mockAssayerRepo,
        },
        {
          provide: getRepositoryToken(AssignmentEntity),
          useValue: mockAssignmentRepo,
        },
        {
          provide: getRepositoryToken(ScheduleEntity),
          useValue: mockAssignmentRepo, // Reuse mockAssignmentRepo for ScheduleEntity
        },
        {
          provide: getRepositoryToken(AssayerCommercialProfileEntity),
          useValue: mockCommercialRepo,
        },
        {
          provide: getRepositoryToken(ClientEntity),
          useValue: mockClientRepo,
        },
        {
          provide: getRepositoryToken(ProjectBranchEntity),
          useValue: mockProjectBranchRepo,
        },
        {
          provide: getRepositoryToken(ValidationQueryEntity),
          useValue: mockQueryRepo,
        },
        {
          provide: RoutingService,
          useValue: mockRoutingService,
        },
        {
          provide: RuleEngine,
          useValue: mockRuleEngine,
        },
        {
          provide: AssayerService,
          useValue: mockAssayerService,
        },
        {
          provide: HolidayService,
          useValue: mockHolidayService,
        },
        {
          provide: HolidayService,
          useValue: {},
        },
      ],
    }).compile();

    engine = module.get<RecommendationEngine>(RecommendationEngine);
    jest.clearAllMocks();
    // Defaults restored after clearAllMocks, which wipes implementations. `findOne` must
    // resolve rather than return undefined: recommend() now awaits it as part of resolving
    // the branch facts it shares across candidates.
    mockAssignmentRepo.find.mockResolvedValue([]);
    mockAssignmentRepo.findOne.mockResolvedValue(null);
    mockAssignmentRepo.count.mockResolvedValue(0);
    // recommend() also awaits these while resolving the facts it shares across candidates,
    // so they must resolve rather than return undefined.
    mockProjectBranchRepo.findOne.mockResolvedValue(null);
    mockRoutingService.calculateRoute.mockResolvedValue({ distanceKm: 10, durationMinutes: 20 });
    mockCommercialRepo.find.mockResolvedValue([]);
    mockCommercialRepo.findOne.mockResolvedValue(null);
    mockQueryRepo.find.mockResolvedValue([]);
    mockQueryRepo.count.mockResolvedValue(0);
    // createQueryBuilder is a factory, so clearAllMocks strips its implementation too.
    mockAssignmentRepo.createQueryBuilder.mockImplementation(groupedCountBuilder);
    mockQueryRepo.createQueryBuilder.mockImplementation(groupedCountBuilder);
  });

  it('should filter out inactive assayers', async () => {
    mockAssayerRepo.find.mockResolvedValue([
      {
        id: 'a-1',
        status: 'INACTIVE',
        isActive: true,
        latitude: 19.0,
        longitude: 72.8,
      },
    ]);

    const branch = {
      id: 'b-1',
      latitude: 19.076,
      longitude: 72.877,
    } as any;

    const results = await engine.recommend(branch, new Date());
    expect(results).toHaveLength(0);
  });

  it('should filter out double-booked assayers', async () => {
    mockAssayerRepo.find.mockResolvedValue([
      {
        id: 'a-1',
        status: 'ACTIVE',
        isActive: true,
        latitude: 19.0,
        longitude: 72.8,
      },
    ]);

    /**
     * Double-booking is now resolved for the whole pool in one query rather than per
     * candidate, so the fixture answers that query instead of the old per-assayer findOne.
     * The rule under test is unchanged: an assayer already committed on the scheduled date
     * must not be offered a second branch that day.
     */
    mockAssignmentRepo.find.mockImplementation(async (opts: any) => {
      const status = opts?.where?.status;
      const isDoubleBookingProbe = status && JSON.stringify(status).includes('ACCEPTED');
      return isDoubleBookingProbe
        ? [{ assayerId: 'a-1', assignmentNumber: 'ASN-EXISTING' }]
        : [];
    });
    // Kept so the standalone (non-batched) path is still covered by this fixture.
    mockAssignmentRepo.findOne.mockResolvedValue({ id: 'existing-assignment' });

    const branch = {
      id: 'b-1',
      latitude: 19.076,
      longitude: 72.877,
    } as any;

    const results = await engine.recommend(branch, new Date());
    expect(results).toHaveLength(0);
  });

  it('should score and rank eligible candidates', async () => {
    const assayerClose = {
      id: 'a-close',
      status: 'ACTIVE',
      isActive: true,
      latitude: 19.08,
      longitude: 72.88,
      performanceRating: 5.0,
      experienceYears: 8,
    };

    const assayerFar = {
      id: 'a-far',
      status: 'ACTIVE',
      isActive: true,
      latitude: 20.5,
      longitude: 73.5,
      performanceRating: 4.0,
      experienceYears: 3,
    };

    mockAssayerRepo.find.mockResolvedValue([assayerClose, assayerFar]);
    mockAssignmentRepo.findOne.mockResolvedValue(null);

    mockRoutingService.calculateRoute
      .mockResolvedValueOnce({ distanceKm: 5, durationMinutes: 10 })
      .mockResolvedValueOnce({ distanceKm: 80, durationMinutes: 120 })
      .mockResolvedValueOnce({ distanceKm: 5, durationMinutes: 10 })
      .mockResolvedValueOnce({ distanceKm: 80, durationMinutes: 120 });

    mockAssignmentRepo.count.mockResolvedValue(0);
    mockCommercialRepo.find.mockResolvedValue([]);
    mockClientRepo.findOne.mockResolvedValue(null);

    const branch = {
      id: 'b-1',
      latitude: 19.076,
      longitude: 72.877,
    } as any;

    const results = await engine.recommend(branch, new Date());

    expect(results).toHaveLength(2);
    expect(results[0].assayer.id).toBe('a-close');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('should flag (not exclude) the assayer holding an unconfirmed pending offer on this branch', async () => {
    const assayerPending = {
      id: 'a-pending', status: 'ACTIVE', isActive: true, latitude: 19.08, longitude: 72.88,
    };
    const assayerFresh = {
      id: 'a-fresh', status: 'ACTIVE', isActive: true, latitude: 19.09, longitude: 72.89,
    };

    mockAssayerRepo.find.mockResolvedValue([assayerPending, assayerFresh]);
    mockAssignmentRepo.count.mockResolvedValue(0);
    mockCommercialRepo.find.mockResolvedValue([]);
    mockClientRepo.findOne.mockResolvedValue(null);
    mockRoutingService.calculateRoute.mockResolvedValue({ distanceKm: 5, durationMinutes: 10 });

    // Distinguish the three different findOne() call shapes that share this mock:
    // the new "pending offer on this branch" lookup (has status: PENDING), the
    // ConsecutiveBranchAuditFilter lookup (no status filter), and checkDoubleBooking
    // (status: In([ACCEPTED])) — only the first should report a match here.
    mockAssignmentRepo.findOne.mockImplementation(async (opts: any) => {
      if (opts?.where?.status === AssignmentStatus.PENDING) {
        return { assayerId: 'a-pending', projectBranch: { branchId: 'b-1' } };
      }
      return null;
    });

    const branch = { id: 'b-1', latitude: 19.076, longitude: 72.877 } as any;

    const results = await engine.recommend(branch, new Date());

    expect(results).toHaveLength(2);
    const pendingResult = results.find((r) => r.assayer.id === 'a-pending');
    const freshResult = results.find((r) => r.assayer.id === 'a-fresh');
    expect(pendingResult?.pendingOnThisBranch).toBe(true);
    expect(freshResult?.pendingOnThisBranch).toBe(false);
  });

  it('should handle missing coordinates gracefully by calculating fallback scores', async () => {
    const assayerNoCoords = {
      id: 'a-no-coords',
      status: 'ACTIVE',
      isActive: true,
      latitude: null,
      longitude: null,
      performanceRating: 5.0,
      experienceYears: 5,
    };

    mockAssayerRepo.find.mockResolvedValue([assayerNoCoords]);
    mockAssignmentRepo.findOne.mockResolvedValue(null);
    mockAssignmentRepo.count.mockResolvedValue(0);
    mockCommercialRepo.find.mockResolvedValue([]);
    mockClientRepo.findOne.mockResolvedValue(null);

    const branch = {
      id: 'b-1',
      latitude: 19.076,
      longitude: 72.877,
    } as any;

    const results = await engine.recommend(branch, new Date());
    expect(results).toHaveLength(1);
    expect(results[0].assayer.id).toBe('a-no-coords');
    expect(results[0].breakdown.distance).toBe(0);
  });
});

describe('BranchFamiliarityScoreCalculator', () => {
  const mockAssignmentRepo = {
    count: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };

  const calculator = new BranchFamiliarityScoreCalculator(mockAssignmentRepo as any);

  const branch = { id: 'branch-1', latitude: 19.076, longitude: 72.877 } as any;
  const assayer = { id: 'assayer-1' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scores an assayer with no prior visits to this branch at the baseline', async () => {
    mockAssignmentRepo.count.mockResolvedValue(0);

    const score = await calculator.calculate(assayer, { branch, client: null, scheduledDate: new Date(), weights: {} });

    expect(score).toBe(50);
    expect(mockAssignmentRepo.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assayerId: 'assayer-1',
          projectBranch: { branchId: 'branch-1' },
        }),
      }),
    );
  });

  it('scores an assayer with prior accepted/completed visits to this branch higher than a stranger', async () => {
    mockAssignmentRepo.count.mockResolvedValue(2);

    const score = await calculator.calculate(assayer, { branch, client: null, scheduledDate: new Date(), weights: {} });

    expect(score).toBe(50 + 2 * 15);
    expect(score).toBeGreaterThan(50);
  });

  it('caps the branch-history bonus at 3+ prior visits', async () => {
    mockAssignmentRepo.count.mockResolvedValue(10);

    const score = await calculator.calculate(assayer, { branch, client: null, scheduledDate: new Date(), weights: {} });

    expect(score).toBe(50 + 3 * 15);
  });
});

describe('ConsecutiveBranchAuditFilter', () => {
  const mockAssignmentRepo = {
    findOne: jest.fn(),
  };

  const filter = new ConsecutiveBranchAuditFilter(mockAssignmentRepo as any);

  const branch = { id: 'branch-1' } as any;
  const assayer = { id: 'assayer-1' } as any;
  const context = { branch, client: null, scheduledDate: new Date(), weights: {} };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows the candidate through when there is no prior assignment on this branch', async () => {
    mockAssignmentRepo.findOne.mockResolvedValue(null);
    await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
  });

  it('does NOT exclude the assayer whose offer on this branch is still PENDING', async () => {
    mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: AssignmentStatus.PENDING });
    await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
  });

  it('excludes the assayer once their assignment on this branch is ACCEPTED', async () => {
    mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: AssignmentStatus.ACCEPTED });
    await expect(filter.evaluate(assayer, context)).resolves.toBe(false);
  });

  it('excludes the assayer who already COMPLETED the last audit of this branch', async () => {
    mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: AssignmentStatus.COMPLETED });
    await expect(filter.evaluate(assayer, context)).resolves.toBe(false);
  });

  it('does not exclude a different assayer even if the last assignment was ACCEPTED', async () => {
    mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'someone-else', status: AssignmentStatus.ACCEPTED });
    await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
  });

  it('does not exclude the assayer whose prior offer on this branch was REJECTED', async () => {
    mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: AssignmentStatus.REJECTED });
    await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
  });
});

