import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AssignmentStatus, BypassableRule } from '@fapoms/shared';
import {
  RecommendationEngine,
  DeployabilityFilter,
  AvailabilityFilter,
  ConsecutiveBranchAuditFilter,
  ClientRestrictionFilter,
  ClientEligibilityFilter,
  RuleEngineEligibilityFilter,
  RequiredSkillsFilter,
  DistancePolicyFilter,
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
import { RuleBypassService } from '../platform/rule-bypass/rule-bypass.service';
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
    // The geo pre-filter issues a raw ST_DistanceSphere query. Returning [] makes
    // findNearbyActiveAssayerIds fall back to the full active pool, so these tests see
    // every mocked assayer exactly as before the pre-filter was added.
    query: jest.fn().mockResolvedValue([]),
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

  /**
   * Which rules an administrator currently has suspended. Empty for almost every test — rules are
   * enforced unless somebody suspends them, and that is the state these tests are about — but a
   * test can add to it to exercise the bypass actually taking effect.
   */
  const bypassedRules = new Set<string>();

  beforeEach(async () => {
    bypassedRules.clear();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          // See modules/platform/rule-bypass.
          provide: RuleBypassService,
          useValue: {
            isBypassedSync: (rule: string) => bypassedRules.has(rule),
            isBypassed: async (rule: string) => bypassedRules.has(rule),
            noteBypass: () => undefined,
          },
        },
        RecommendationEngine,
        DeployabilityFilter,
        AvailabilityFilter,
        ConsecutiveBranchAuditFilter,
        ClientRestrictionFilter,
        ClientEligibilityFilter,
        RuleEngineEligibilityFilter,
        RequiredSkillsFilter,
        DistancePolicyFilter,
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

  /**
   * The reported bug: a newly added assayer is plainly there on the HR roster, and planning
   * answers "No assayers found in range for this date".
   *
   * `AssayerService.create` opens every profile at INVITED / status INACTIVE, and the pool
   * query asked for `status = ACTIVE` — so the person was not merely ineligible, they never
   * entered the pool and no exclusion reason was recorded. The list and the explanation under
   * it were both empty, which is indistinguishable from "nobody lives near this branch".
   */
  describe('assayers who have not finished onboarding', () => {
    const onboardingAssayer = {
      id: 'a-new',
      displayName: 'Newly Added',
      status: 'INACTIVE',
      lifecycleStatus: 'TRAINING',
      isActive: true,
      latitude: 19.0,
      longitude: 72.8,
    };

    const branch = { id: 'b-1', latitude: 19.076, longitude: 72.877 } as any;

    it('is explained rather than silently dropped', async () => {
      mockAssayerRepo.find.mockResolvedValue([onboardingAssayer]);

      const results = await engine.recommend(branch, new Date());

      // Still not selectable — dispatching untrained people is what the lifecycle prevents.
      expect(results).toHaveLength(0);
      // But now there is an answer to "where is the assayer I just added?".
      const excluded = (results as any).excluded;
      expect(excluded).toHaveLength(1);
      expect(excluded[0]).toMatchObject({ assayerId: 'a-new', kind: 'ONBOARDING' });
      // And it names the stage plus the fix, not just "unavailable on this date".
      expect(excluded[0].detail).toContain('training');
    });

    it('is not reported as a date problem, because no date would help', async () => {
      mockAssayerRepo.find.mockResolvedValue([onboardingAssayer]);

      const excluded = (await engine.recommend(branch, new Date()) as any).excluded;

      expect(excluded[0].kind).not.toBe('DATE');
      // A DATE exclusion carries a "free from" date; this one must not, or the UI offers to
      // reschedule around a block that rescheduling cannot clear.
      expect(excluded[0].nextAvailableDate).toBeNull();
    });

    /**
     * `status` and `lifecycle_status` are Postgres enum types. Comparing either to a text
     * parameter is a hard error, not a coercion — and the caller catches it and falls back to
     * the full pool, so the pre-filter would silently stop bounding anything while every test
     * with a mocked repository still passed.
     */
    it('casts the enum columns in the geographic pre-filter', async () => {
      mockAssayerRepo.find.mockResolvedValue([]);

      await engine.recommend(branch, new Date());

      const sql: string = mockAssayerRepo.query.mock.calls.at(-1)?.[0] ?? '';
      expect(sql).toContain('a.status::text');
      expect(sql).toContain('a.lifecycle_status::text');
    });

    /**
     * The radius search must stay index-shaped, and it must keep measuring the way it always has.
     *
     * This query runs on every planning request against the whole workforce. Written as
     * `ST_DistanceSphere(ST_MakePoint(a.longitude, a.latitude), …)` it measured the exact distance
     * to every assayer and could not use the GiST index the table already carries — the point
     * being compared did not exist until the query ran. On a 5,000-assayer set that was 89 ms of
     * sequential scan; `ST_DWithin` against the stored geometry is under 4 ms for the same 321
     * candidates.
     *
     * Both halves are asserted because either one silently undoes the other: wrapping the column
     * (in COALESCE, or anything) makes the index unusable again, and dropping `false` switches
     * geography to its WGS84 spheroid default, which moves the boundary — 322 candidates instead
     * of 321 on the same data. Neither failure shows up as anything but latency or a quietly
     * different shortlist.
     */
    it('bounds the radius search with an index-usable ST_DWithin, on the same spherical maths', async () => {
      mockAssayerRepo.find.mockResolvedValue([]);

      await engine.recommend(branch, new Date());

      const sql: string = mockAssayerRepo.query.mock.calls.at(-1)?.[0] ?? '';
      expect(sql).toContain('ST_DWithin');
      // The bare column, so the expression matches the functional index on (location::geography).
      expect(sql).toContain('a.location::geography');
      expect(sql).not.toContain('COALESCE(a.location');
      // use_spheroid = false: the same sphere ST_DistanceSphere used, so the shortlist is unchanged.
      expect(sql).toMatch(/\$4,\s*false\)/);
      // The per-row exact distance this replaced must not creep back in.
      expect(sql).not.toContain('ST_DistanceSphere');
    });

    it('queries for onboarding profiles as well as active ones', async () => {
      mockAssayerRepo.find.mockResolvedValue([]);

      await engine.recommend(branch, new Date());

      // An OR, expressed to TypeORM as an array of where clauses. Without the second clause
      // the fix cannot work no matter what the filters say.
      const where = mockAssayerRepo.find.mock.calls.at(-1)?.[0]?.where;
      expect(Array.isArray(where)).toBe(true);
      expect(where).toHaveLength(2);
      expect(where[1]).toHaveProperty('lifecycleStatus');
    });

    /**
     * The whole point of suspending ASSAYER_ONBOARDING: an administrator testing a workflow gets
     * to use the person they just added, without waiting out document and background checks.
     *
     * It did not work. DeployabilityFilter honoured the bypass and let them through, and
     * AvailabilityFilter — which re-checked `status !== 'ACTIVE'` as a "backstop" — rejected them
     * one filter later under a reason about a specific day: "already booked or on leave", for
     * someone with neither. The bypass appeared broken and the exclusion panel gave a false
     * explanation for why.
     */
    it('becomes selectable when an administrator has suspended the onboarding rule', async () => {
      bypassedRules.add(BypassableRule.ASSAYER_ONBOARDING);
      mockAssayerRepo.find.mockResolvedValue([onboardingAssayer]);

      const results = await engine.recommend(branch, new Date());

      expect(results).toHaveLength(1);
      expect(results[0].assayer.id).toBe('a-new');
      expect((results as any).excluded).toHaveLength(0);
    });

    it('is still excluded, and still for the onboarding reason, with no bypass in force', async () => {
      mockAssayerRepo.find.mockResolvedValue([onboardingAssayer]);

      const excluded = (await engine.recommend(branch, new Date()) as any).excluded;

      expect(excluded).toHaveLength(1);
      expect(excluded[0].kind).toBe('ONBOARDING');
    });

    /**
     * Suspending onboarding says vetting is incomplete, not that a record somebody removed from
     * the workforce should come back. Deleting is the one thing no bypass overrides.
     */
    it('does not resurrect a deleted profile, bypass or not', async () => {
      bypassedRules.add(BypassableRule.ASSAYER_ONBOARDING);
      mockAssayerRepo.find.mockResolvedValue([{ ...onboardingAssayer, isActive: false }]);

      const results = await engine.recommend(branch, new Date());

      expect(results).toHaveLength(0);
    });
  });

  /**
   * The geographic pre-filter runs before every eligibility rule, so anyone it drops produces
   * no exclusion reason — they are simply absent from both lists.
   *
   * That contradicted itself on screen: the planning map draws assayers by the operator's own
   * search radius (350 km, say) while the pre-filter prunes at 200 km, so five pins appeared
   * around a branch whose candidate list AND whose "excluded" panel were both empty. Reported
   * on live data as "7 assayers on the map, none in recommendations".
   */
  describe('assayers pruned by the geographic pre-filter', () => {
    const branch = { id: 'b-1', latitude: 18.52, longitude: 73.85 } as any;

    it('reports them as a distance exclusion rather than dropping them silently', async () => {
      // The pre-filter keeps a-near; the follow-up query reports a-far as pruned.
      mockAssayerRepo.query
        .mockResolvedValueOnce([{ id: 'a-near' }])
        .mockResolvedValueOnce([{ id: 'a-far', displayName: 'Distant Deepa', distanceKm: '412.7' }]);
      mockAssayerRepo.find.mockResolvedValue([
        { id: 'a-near', displayName: 'Nearby Nilesh', status: 'ACTIVE', isActive: true, latitude: 18.5, longitude: 73.8 },
      ]);

      const results = await engine.recommend(branch, new Date());
      const excluded = (results as any).excluded;

      const pruned = excluded.find((e: any) => e.assayerId === 'a-far');
      expect(pruned).toBeDefined();
      expect(pruned.kind).toBe('DISTANCE');
      // The number is the point: "outside the search area" without a distance is not actionable.
      expect(pruned.reason).toContain('km candidate search area');
      expect(pruned.detail).toContain('413 km away');
    });

    it('leaves the rule-based exclusions first, so the actionable ones stay at the top', async () => {
      mockAssayerRepo.query
        .mockResolvedValueOnce([{ id: 'a-blocked' }])
        .mockResolvedValueOnce([{ id: 'a-far', displayName: 'Distant Deepa', distanceKm: '412.7' }]);
      // Not deployable, so a rule excludes them — that reason must outrank the geography note.
      mockAssayerRepo.find.mockResolvedValue([
        { id: 'a-blocked', displayName: 'Onboarding Omkar', status: 'INACTIVE', lifecycleStatus: 'TRAINING', isActive: true, latitude: 18.5, longitude: 73.8 },
      ]);

      const excluded = (await engine.recommend(branch, new Date()) as any).excluded;

      expect(excluded[0].assayerId).toBe('a-blocked');
      expect(excluded.at(-1).assayerId).toBe('a-far');
    });

    /**
     * The operator's radius has to reach the engine, not just the display filter.
     *
     * Reported on live data as "I set 350 km on the map and see 7 assayers, but the
     * recommendation list is empty" — they were all beyond a fixed 200 km search area that
     * nothing in the UI mentioned or could change.
     */
    it('searches the radius the operator asked for', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-near' }]);
      mockAssayerRepo.find.mockResolvedValue([]);

      await engine.recommend(branch, new Date(), {}, undefined, { searchRadiusKm: 350 });

      // Metres, in the fourth bind parameter of the spatial pre-filter query.
      const params = mockAssayerRepo.query.mock.calls[0]?.[1];
      expect(params[3]).toBe(350 * 1000);
    });

    it('keeps the default search area when the operator sets none', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-near' }]);
      mockAssayerRepo.find.mockResolvedValue([]);

      await engine.recommend(branch, new Date());

      expect(mockAssayerRepo.query.mock.calls[0]?.[1][3]).toBe(200 * 1000);
    });

    it('caps an absurd radius rather than scanning the country', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-near' }]);
      mockAssayerRepo.find.mockResolvedValue([]);

      await engine.recommend(branch, new Date(), {}, undefined, { searchRadiusKm: 99999 });

      expect(mockAssayerRepo.query.mock.calls[0]?.[1][3]).toBe(1000 * 1000);
    });

    it('says nothing extra when the pre-filter pruned nobody', async () => {
      mockAssayerRepo.query
        .mockResolvedValueOnce([{ id: 'a-near' }])
        .mockResolvedValueOnce([]);
      mockAssayerRepo.find.mockResolvedValue([
        { id: 'a-near', displayName: 'Nearby Nilesh', status: 'ACTIVE', isActive: true, latitude: 18.5, longitude: 73.8 },
      ]);

      const excluded = (await engine.recommend(branch, new Date()) as any).excluded;
      expect(excluded.filter((e: any) => e.kind === 'DISTANCE')).toHaveLength(0);
    });
  });

  /**
   * "Remove this restriction or make the date-related availability check optional." The date
   * filter answers a narrower question than ops asks first — who can cover this branch at all
   * — and a clash is normally resolved by moving the date, not by dropping the person.
   */
  describe('relaxed date availability', () => {
    const bookedAssayer = {
      id: 'a-1',
      displayName: 'Booked Bina',
      status: 'ACTIVE',
      isActive: true,
      latitude: 19.0,
      longitude: 72.8,
    };
    const branch = { id: 'b-1', latitude: 19.076, longitude: 72.877 } as any;

    /** Answers the pool-wide double-booking probe for `a-1`. */
    const bookAssayerOnTheDay = () => {
      mockAssignmentRepo.find.mockImplementation(async (opts: any) => {
        const status = opts?.where?.status;
        const isDoubleBookingProbe = status && JSON.stringify(status).includes('ACCEPTED');
        return isDoubleBookingProbe ? [{ assayerId: 'a-1', assignmentNumber: 'ASN-EXISTING' }] : [];
      });
    };

    it('ranks a candidate who is booked that day', async () => {
      mockAssayerRepo.find.mockResolvedValue([bookedAssayer]);
      bookAssayerOnTheDay();

      const results = await engine.recommend(branch, new Date(), {}, undefined, {
        relaxAvailability: true,
      });

      expect(results).toHaveLength(1);
      expect(results[0].assayer.id).toBe('a-1');
    });

    it('still states the clash on the candidate it kept', async () => {
      mockAssayerRepo.find.mockResolvedValue([bookedAssayer]);
      bookAssayerOnTheDay();

      const results = await engine.recommend(branch, new Date(), {}, undefined, {
        relaxAvailability: true,
      });

      // Relaxing a filter is a request to see past a constraint, not to be kept from knowing
      // it exists — without this the operator dispatches into a double-booking.
      expect(results[0].dateConflict).toContain('ASN-EXISTING');
    });

    it('leaves a genuinely free candidate unflagged', async () => {
      mockAssayerRepo.find.mockResolvedValue([bookedAssayer]);

      const results = await engine.recommend(branch, new Date(), {}, undefined, {
        relaxAvailability: true,
      });

      expect(results[0].dateConflict).toBeNull();
    });

    it('does not relax deployability', async () => {
      mockAssayerRepo.find.mockResolvedValue([
        { ...bookedAssayer, status: 'INACTIVE', lifecycleStatus: 'INVITED' },
      ]);

      const results = await engine.recommend(branch, new Date(), {}, undefined, {
        relaxAvailability: true,
      });

      // Onboarding is a control, not a preference: this toggle must never dispatch someone
      // who has not cleared document checks, background verification and training.
      expect(results).toHaveLength(0);
      expect((results as any).excluded[0].kind).toBe('ONBOARDING');
    });

    it('excludes the booked candidate when not relaxed', async () => {
      mockAssayerRepo.find.mockResolvedValue([bookedAssayer]);
      bookAssayerOnTheDay();

      const results = await engine.recommend(branch, new Date());

      expect(results).toHaveLength(0);
      expect((results as any).excluded[0].kind).toBe('DATE');
    });
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

  // Rules are enforced unless an administrator has suspended them — see
  // modules/platform/rule-bypass. Nothing is suspended in these tests, which is the state
  // the rotation rule is actually asserting about.
  const noBypass = { isBypassedSync: () => false, isBypassed: async () => false, noteBypass: () => undefined } as any;
  const filter = new ConsecutiveBranchAuditFilter(mockAssignmentRepo as any, noBypass);

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

/**
 * Cost and Profitability both price the same assayer. They must select the same commercial
 * profile, and it must be the one FeePolicyService would bill against — the profile in force
 * on the audit date. Profitability previously took whichever profile was newest, so an assayer
 * with a rate rise dated in the future was scored cheap by one and expensive by the other in
 * the same recommendation.
 */
describe('commercial profile selection is the same for every scorer', () => {
  const AUDIT_DATE = new Date('2026-08-20');

  // Newest first, matching both the batched preload and the per-candidate query fallback.
  const PROFILES = [
    { id: 'p-future', baseFee: 9000, dailyRate: 1000, effectiveStartDate: new Date('2026-12-01'), effectiveEndDate: null },
    { id: 'p-current', baseFee: 2000, dailyRate: 500, effectiveStartDate: new Date('2026-01-01'), effectiveEndDate: null },
  ];

  const assayer: any = { id: 'a-1' };
  const contextFor = (profiles: any[]): any => ({
    branch: { id: 'b-1', city: 'Pune' },
    scheduledDate: AUDIT_DATE,
    client: { budget: 5000 },
    branchFacts: { commercialProfilesByAssayer: { 'a-1': profiles } },
  });

  const repoReturning = (profiles: any[]) => ({
    find: jest.fn().mockResolvedValue(profiles),
    findOne: jest.fn().mockResolvedValue(profiles[0] ?? null),
  });

  it('prices against the profile in force on the audit date, not the newest one', async () => {
    const cost = new CostScoreCalculator(repoReturning(PROFILES) as any);
    const profitability = new ProfitabilityScoreCalculator(repoReturning(PROFILES) as any);

    // Only the current profile is in force on the audit date. p-future (9000) starts in
    // December, and a 9000 base fee against a 5000 budget would score 0 here.
    const costScore = await cost.calculate(assayer, contextFor(PROFILES));
    const profitScore = await profitability.calculate(assayer, contextFor(PROFILES));

    // 2000 + 500 = 2500 against a 5000 budget is comfortably under, so profitability is high.
    expect(profitScore).toBeGreaterThan(50);
    // And cost reflects the same 2000 base fee rather than 9000.
    expect(costScore).toBeGreaterThan(80);
  });

  it('agrees with the Cost scorer when only a future profile exists', async () => {
    const onlyFuture = [PROFILES[0]];
    const cost = new CostScoreCalculator(repoReturning(onlyFuture) as any);
    const profitability = new ProfitabilityScoreCalculator(repoReturning(onlyFuture) as any);

    // Neither scorer may fall back to a rate that is not yet in force; both report "unknown".
    await expect(cost.calculate(assayer, contextFor(onlyFuture))).resolves.toBe(50);
    await expect(profitability.calculate(assayer, contextFor(onlyFuture))).resolves.toBe(50);
  });

  it('respects an expired profile the same way in both scorers', async () => {
    const expired = [{ ...PROFILES[1], effectiveEndDate: new Date('2026-03-01') }];
    const cost = new CostScoreCalculator(repoReturning(expired) as any);
    const profitability = new ProfitabilityScoreCalculator(repoReturning(expired) as any);

    await expect(cost.calculate(assayer, contextFor(expired))).resolves.toBe(50);
    await expect(profitability.calculate(assayer, contextFor(expired))).resolves.toBe(50);
  });
});
