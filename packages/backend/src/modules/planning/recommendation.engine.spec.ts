import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AssignmentStatus, BypassableRule, AssayerLifecycleStatus } from '@fapoms/shared';
import {
  RecommendationEngine,
  DeployabilityFilter,
  AvailabilityFilter,
  ConsecutiveBranchAuditFilter,
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
  RemarksScoreCalculator,
  FairnessScoreCalculator,
  getCityTierMultiplier,
  acceptanceRateScore,
  deliveryDays,
  deliverySpeedScore,
  ANSWERED_OFFER_STATUSES,
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
import { AssayerRemarksService } from '../assayer-remarks/assayer-remarks.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';

describe('RecommendationEngine', () => {
  let engine: RecommendationEngine;

  /**
   * Grouped-count query builder shape used by the engine's fact resolution. `innerJoin` is here
   * because the prior-visit and same-day preloads reach through project_branches to the branch.
   */
  const groupedCountBuilder = () => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
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

  /**
   * What the assayer repository hands the engine. The real repository returns `AssayerEntity`
   * instances, and the engine reads the entity's *getters* — `effectiveLatitude` /
   * `effectiveLongitude` (the live fix if shared, else home) — to decide who gets routed at all.
   * Fixture rows are plain objects with no getters, so for as long as `find` returned them raw
   * nobody in this file had a position: no candidate was ever routed, the routing double below
   * was never called, and the distance figures a test queued were silently ignored. Rows are
   * therefore hydrated into entities on the way out, exactly as TypeORM would hand them over.
   * Tests keep configuring and asserting on `mockAssayerRepo.find` itself.
   */
  const asAssayerEntity = (row: Record<string, unknown>): AssayerEntity => Object.assign(new AssayerEntity(), row);
  const assayerRepositoryForEngine = {
    ...mockAssayerRepo,
    find: async (...args: unknown[]) => {
      const rows = await mockAssayerRepo.find(...args);
      return Array.isArray(rows) ? rows.map(asAssayerEntity) : rows;
    },
  };

  const mockAssignmentRepo = {
    findOne: jest.fn(),
    count: jest.fn(),
    find: jest.fn(),
    /**
     * Raw reads the engine makes for the whole pool: the rotation rule's last auditor
     * (assignment/branch-rotation.ts) and the per-assayer delivery history (20 each, cut in SQL).
     * Empty means "never audited, no history" — what these fixtures already assumed.
     */
    query: jest.fn().mockResolvedValue([]),
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

  /**
   * The engine routes the whole candidate pool in one `calculateDistances` batch and only falls
   * back to per-candidate `calculateRoute` if the batch throws. A double that stubs only
   * `calculateRoute` makes the batch throw (it is `undefined`), so every test would exercise the
   * fallback and never the path production runs. The default `calculateDistances` therefore
   * answers the batch by mapping each destination, in order, through the `calculateRoute` stub —
   * so a test that queues per-candidate figures with `mockResolvedValueOnce` still hands them
   * out one per candidate, and the batch path is what runs. Answers are labelled `OSRM` because
   * that is what a routed batch returns; a stub that sets its own `source` keeps it.
   */
  const batchViaCalculateRoute = async (
    origin: { latitude: number; longitude: number },
    destinations: Array<{ id: string; latitude: number; longitude: number }>,
    mode?: string,
  ): Promise<Record<string, { distanceKm: number; durationMinutes: number; source: 'OSRM' | 'ESTIMATE' }>> => {
    const results: Record<string, { distanceKm: number; durationMinutes: number; source: 'OSRM' | 'ESTIMATE' }> = {};
    for (const d of destinations) {
      const route = await mockRoutingService.calculateRoute(origin, d, mode);
      if (route) results[d.id] = { ...route, source: route.source ?? 'OSRM' };
    }
    return results;
  };

  const mockRoutingService = {
    calculateRoute: jest.fn(),
    calculateDistances: jest.fn(batchViaCalculateRoute),
  };

  /**
   * Staff remarks for the pool, keyed by assayer id — what recommend() preloads through the
   * remarks module. Empty means nobody has said anything, which scores every candidate a
   * neutral 50 on that dimension.
   */
  const mockRemarksService = {
    loadScoringWindow: jest.fn().mockResolvedValue({}),
  };

  /**
   * `planning.fairnessOfferCap`; 8 is the shipped default. The no-empanelment-row policy is
   * stubbed to ALLOW: these tests exercise the OTHER filters and scorers with fixtures that
   * predate empanelment rows, and the strict gate has its own truth-table spec
   * (empanelment-eligibility.spec.ts).
   */
  const mockPlatformSettings = {
    getNumber: jest.fn().mockResolvedValue(8),
    get: jest.fn().mockResolvedValue('ALLOW'),
  };

  const mockRuleEngine = {
    evaluate: jest.fn().mockResolvedValue([{ passed: true, actionType: 'ALERT' }]),
    // The engine preloads this branch's rules once and hands them to every candidate's
    // evaluation, instead of the filter re-reading them per assayer.
    loadRules: jest.fn().mockResolvedValue([]),
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
        RemarksScoreCalculator,
        FairnessScoreCalculator,
        ConfigurationResolver,
        ConstraintEvaluator,
        {
          provide: getRepositoryToken(AssayerEntity),
          useValue: assayerRepositoryForEngine,
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
        { provide: AssayerRemarksService, useValue: mockRemarksService },
        { provide: PlatformSettingsService, useValue: mockPlatformSettings },
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
    // The batch is what recommend() actually calls; keep it routed through calculateRoute.
    mockRoutingService.calculateDistances.mockImplementation(batchViaCalculateRoute);
    mockCommercialRepo.find.mockResolvedValue([]);
    mockCommercialRepo.findOne.mockResolvedValue(null);
    mockQueryRepo.find.mockResolvedValue([]);
    mockQueryRepo.count.mockResolvedValue(0);
    // createQueryBuilder is a factory, so clearAllMocks strips its implementation too.
    mockAssignmentRepo.createQueryBuilder.mockImplementation(groupedCountBuilder);
    mockQueryRepo.createQueryBuilder.mockImplementation(groupedCountBuilder);
    mockRemarksService.loadScoringWindow.mockResolvedValue({});
    mockPlatformSettings.getNumber.mockResolvedValue(8);
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

  /**
   * Owner decision 2026-09-24 (E2): one assayer may take several branches on the same day. Someone
   * already committed that day is no longer filtered out — the same-day route grouping score is
   * the only place their other booking now counts, and it counts in their favour.
   */
  it('keeps an assayer who is already booked that day', async () => {
    mockAssayerRepo.find.mockResolvedValue([
      {
        id: 'a-1',
        status: 'ACTIVE',
        lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
        isActive: true,
        latitude: 19.0,
        longitude: 72.8,
      },
    ]);

    mockAssignmentRepo.find.mockImplementation(async (opts: any) => {
      const status = opts?.where?.status;
      const isDoubleBookingProbe = status && JSON.stringify(status).includes('ACCEPTED');
      return isDoubleBookingProbe
        ? [{ assayerId: 'a-1', assignmentNumber: 'ASN-EXISTING' }]
        : [];
    });

    const branch = {
      id: 'b-1',
      latitude: 19.076,
      longitude: 72.877,
    } as any;

    const results = await engine.recommend(branch, new Date());
    expect(results).toHaveLength(1);
    expect(results[0].assayer.id).toBe('a-1');
    expect((results as any).excluded ?? []).toHaveLength(0);
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
        { id: 'a-near', displayName: 'Nearby Nilesh', status: 'ACTIVE', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, isActive: true, latitude: 18.5, longitude: 73.8 },
      ]);

      const results = await engine.recommend(branch, new Date());
      const excluded = (results as any).excluded;

      const pruned = excluded.find((e: any) => e.assayerId === 'a-far');
      expect(pruned).toBeDefined();
      expect(pruned.kind).toBe('DISTANCE');
      // The number is the point: "outside the search area" without a distance is not actionable.
      expect(pruned.reason).toContain('km candidate search area');
      expect(pruned.detail).toContain('413 km away');
      // The pre-filter measured on a sphere, never on the road; the row says so rather than
      // letting the panel dress a straight line up as a road figure.
      expect(pruned.distanceSource).toBe('ESTIMATE');
      expect(pruned.detail).toContain('straight line');
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
      // A rule-blocked candidate was routed with the pool, so its row carries the batch's
      // figure AND its label — the panel says "by road" only because the engine said OSRM.
      expect(excluded[0].distanceKm).toBeGreaterThan(0);
      expect(excluded[0].distanceSource).toBe('OSRM');
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
        { id: 'a-near', displayName: 'Nearby Nilesh', status: 'ACTIVE', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, isActive: true, latitude: 18.5, longitude: 73.8 },
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
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
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

    it('does not call another booking that day a clash any more (E2)', async () => {
      mockAssayerRepo.find.mockResolvedValue([bookedAssayer]);
      bookAssayerOnTheDay();

      const results = await engine.recommend(branch, new Date(), {}, undefined, {
        relaxAvailability: true,
      });

      // Several branches per day are allowed, so there is nothing to warn about.
      expect(results[0].dateConflict).toBeNull();
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

    it('keeps the booked candidate when not relaxed, too (E2)', async () => {
      mockAssayerRepo.find.mockResolvedValue([bookedAssayer]);
      bookAssayerOnTheDay();

      const results = await engine.recommend(branch, new Date());

      expect(results).toHaveLength(1);
      expect(results[0].assayer.id).toBe('a-1');
    });
  });

  it('should score and rank eligible candidates', async () => {
    const assayerClose = {
      id: 'a-close',
      status: 'ACTIVE',
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      isActive: true,
      latitude: 19.08,
      longitude: 72.88,
      performanceRating: 5.0,
      experienceYears: 8,
    };

    const assayerFar = {
      id: 'a-far',
      status: 'ACTIVE',
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      isActive: true,
      latitude: 20.5,
      longitude: 73.5,
      performanceRating: 4.0,
      experienceYears: 3,
    };

    mockAssayerRepo.find.mockResolvedValue([assayerClose, assayerFar]);
    mockAssignmentRepo.findOne.mockResolvedValue(null);

    // One figure per candidate, in pool order: the batch routes each destination exactly once
    // (it used to be one call per scorer per candidate, so this queue was twice as long, and
    // the unused half leaked into the next test's routing answers).
    mockRoutingService.calculateRoute
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
    // The pool was routed as one batch, not candidate by candidate through the fallback.
    expect(mockRoutingService.calculateDistances).toHaveBeenCalledTimes(1);
    expect(mockRoutingService.calculateDistances).toHaveBeenCalledWith(
      { latitude: 19.076, longitude: 72.877 },
      [
        { id: 'a-close', latitude: 19.08, longitude: 72.88 },
        { id: 'a-far', latitude: 20.5, longitude: 73.5 },
      ],
      'driving',
    );
    // …and the batch's figures are the ones each candidate is scored and shown with.
    expect(results[0].route).toEqual({ distanceKm: 5, durationMinutes: 10, source: 'OSRM' });
    expect(results[1].route).toEqual({ distanceKm: 80, durationMinutes: 120, source: 'OSRM' });
  });

  it('should flag (not exclude) the assayer holding an unconfirmed pending offer on this branch', async () => {
    const assayerPending = {
      id: 'a-pending', status: 'ACTIVE', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, isActive: true, latitude: 19.08, longitude: 72.88,
    };
    const assayerFresh = {
      id: 'a-fresh', status: 'ACTIVE', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, isActive: true, latitude: 19.09, longitude: 72.89,
    };

    mockAssayerRepo.find.mockResolvedValue([assayerPending, assayerFresh]);
    mockAssignmentRepo.count.mockResolvedValue(0);
    mockCommercialRepo.find.mockResolvedValue([]);
    mockClientRepo.findOne.mockResolvedValue(null);
    mockRoutingService.calculateRoute.mockResolvedValue({ distanceKm: 5, durationMinutes: 10 });

    // Distinguish the three different findOne() call shapes that share this mock:
    // the new "pending offer on this branch" lookup (has status: PENDING), the
    // ConsecutiveBranchAuditFilter lookup (no status filter) — only the first should report a
    // match here.
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
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
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

  /**
   * The two dimensions added for staff remarks and rotation fairness. Both tests use a pair of
   * candidates that are identical on every other dimension, so the ranking can only be decided
   * by the dimension under test — which is the strongest statement that it actually moves the
   * answer, and by how much.
   */
  describe('staff remarks and rotation fairness', () => {
    const twin = (id: string) => ({
      id, status: 'ACTIVE', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, isActive: true, latitude: 19.08, longitude: 72.88,
      performanceRating: 5.0, experienceYears: 5,
    });
    const branch = { id: 'b-1', latitude: 19.076, longitude: 72.877 } as any;

    beforeEach(() => {
      mockAssayerRepo.find.mockResolvedValue([twin('a-1'), twin('a-2')]);
      mockClientRepo.findOne.mockResolvedValue(null);
      mockRoutingService.calculateRoute.mockResolvedValue({ distanceKm: 10, durationMinutes: 20 });
    });

    it('a −2 remark yesterday moves the candidate below an otherwise identical peer, by at most the dimension weight', async () => {
      const yesterday = new Date(Date.now() - 86_400_000);
      mockRemarksService.loadScoringWindow.mockResolvedValue({
        'a-1': [{ rating: -2, category: 'CONDUCT', content: 'Was rude to the branch manager.', authorRole: 'OPERATIONS', authorName: 'Ops', createdAt: yesterday }],
      });

      const results = await engine.recommend(branch, new Date());
      const remarked = results.find((r) => r.assayer.id === 'a-1')!;
      const clean = results.find((r) => r.assayer.id === 'a-2')!;

      // One query for the whole pool, with both ids — never once per candidate.
      expect(mockRemarksService.loadScoringWindow).toHaveBeenCalledTimes(1);
      expect(mockRemarksService.loadScoringWindow.mock.calls[0][0]).toEqual(expect.arrayContaining(['a-1', 'a-2']));

      // 50 + 25 × (−2) = 0 for the remarked candidate; nothing said = 50 for the peer.
      expect(remarked.breakdown.remarksScore).toBe(0);
      expect(clean.breakdown.remarksScore).toBe(50);
      expect(results[0].assayer.id).toBe('a-2');
      // The whole dimension is worth 6 points; a 50-point swing on it moves the total by 3.
      // Bounded: no remark history, however bad, can cost more than weight × 100.
      expect(clean.score - remarked.score).toBeCloseTo(3, 1);

      // And the card can say why.
      expect(remarked.remarkSummary).toEqual(expect.objectContaining({ count: 1, weightedMean: -2 }));
      expect(remarked.remarkSummary.latest).toEqual(expect.objectContaining({ rating: -2, category: 'CONDUCT', authorRole: 'OPERATIONS' }));
      expect(clean.remarkSummary).toEqual({ count: 0, weightedMean: null, latest: null });
    });

    it('a candidate with cap-many recent offers loses a dead heat to one who has had none — and only that', async () => {
      // The grouped-count builder serves every per-pool count in recommend(); the recent-offers
      // one is the only query that filters on `a.createdAt >= :since`, so answer only that one.
      const offersAwareBuilder = () => {
        const b: any = groupedCountBuilder();
        let isRecentOffers = false;
        b.andWhere = jest.fn((cond: string) => {
          if (typeof cond === 'string' && cond.includes('a.createdAt >= :since')) isRecentOffers = true;
          return b;
        });
        b.getRawMany = jest.fn(async () => (isRecentOffers ? [{ assayerId: 'a-1', count: 8 }] : []));
        return b;
      };
      mockAssignmentRepo.createQueryBuilder.mockImplementation(offersAwareBuilder);
      mockPlatformSettings.getNumber.mockResolvedValue(8);

      const results = await engine.recommend(branch, new Date());
      const busy = results.find((r) => r.assayer.id === 'a-1')!;
      const idle = results.find((r) => r.assayer.id === 'a-2')!;

      expect(mockPlatformSettings.getNumber).toHaveBeenCalledWith('planning.fairnessOfferCap', 8);
      expect(busy.breakdown.fairness).toBe(0);
      expect(idle.breakdown.fairness).toBe(100);
      expect(results[0].assayer.id).toBe('a-2');
      // 100 points of a 0.04 dimension = 4 points of the total, and not one more.
      expect(idle.score - busy.score).toBeCloseTo(4, 1);
      // Nothing else moved: it is a nudge on this dimension, not a penalty smeared elsewhere.
      for (const k of Object.keys(busy.breakdown)) {
        if (k !== 'fairness') expect(busy.breakdown[k]).toBe(idle.breakdown[k]);
      }
    });

    it('a candidate with a merit lead of more than the fairness weight still wins despite being the busy one', async () => {
      // a-1 is busier AND plainly better: rating 5.0 vs 3.0 (performance 100 vs 60, ×0.07 = 2.8
      // points) and 10 years vs none (experience 100 vs 0, ×0.02 = 2 points) — a 4.8-point merit
      // lead against a 4-point nudge. Merit wins; fairness only settles the close ones.
      mockAssayerRepo.find.mockResolvedValue([
        { ...twin('a-1'), performanceRating: 5.0, experienceYears: 10 },
        { ...twin('a-2'), performanceRating: 3.0, experienceYears: 0 },
      ]);
      const offersAwareBuilder = () => {
        const b: any = groupedCountBuilder();
        let isRecentOffers = false;
        b.andWhere = jest.fn((cond: string) => {
          if (typeof cond === 'string' && cond.includes('a.createdAt >= :since')) isRecentOffers = true;
          return b;
        });
        b.getRawMany = jest.fn(async () => (isRecentOffers ? [{ assayerId: 'a-1', count: 20 }] : []));
        return b;
      };
      mockAssignmentRepo.createQueryBuilder.mockImplementation(offersAwareBuilder);

      const results = await engine.recommend(branch, new Date());
      expect(results[0].assayer.id).toBe('a-1');
      expect(results[0].breakdown.fairness).toBe(0);
      expect(results[1].breakdown.fairness).toBe(100);
    });
  });

  /** The 2026-09-25 recommendations audit, pinned against the real engine. */
  describe('audit 2026-09-25', () => {
    const branch = { id: 'b-1', latitude: 18.52, longitude: 73.85, state: 'Maharashtra', clientId: 'c-1' } as any;
    const active = (over: Record<string, unknown>) => ({
      status: 'ACTIVE', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, isActive: true, skills: [], certifications: [], ...over,
    });
    beforeEach(() => {
      // Empanelment standings are read through the repository's manager; nobody has one here and
      // the no-row policy is ALLOW (see mockPlatformSettings).
      (mockAssignmentRepo as any).manager = { query: jest.fn().mockResolvedValue([]) };
      mockAssignmentRepo.query.mockResolvedValue([]);
      mockClientRepo.findOne.mockResolvedValue(null);
    });
    afterEach(() => { delete (mockAssignmentRepo as any).manager; });

    /** A router that answers straight-line km, so where a point is decides its figure. */
    const straightRouter = () => {
      mockRoutingService.calculateRoute.mockImplementation(async (o: any, d: any) => {
        const km = Math.hypot(o.latitude - d.latitude, o.longitude - d.longitude) * 111;
        return { distanceKm: Math.round(km * 10) / 10, durationMinutes: Math.round(km), source: 'OSRM' };
      });
    };

    /**
     * F7: on the BATCH path (coverage plan, day planner) nobody in range is an empty list — never
     * the national pool, which let a plan deploy somebody 1,500 km away with no exclusion recorded.
     */
    it('F7: the batch path returns nobody when nobody is in range', async () => {
      mockAssayerRepo.query.mockResolvedValue([]);
      const far = Object.assign(new AssayerEntity(), active({ id: 'a-far', displayName: 'Far', latitude: 28.6, longitude: 77.2 }));
      const results = await engine.recommend(branch, new Date(), {}, { client: null, assayers: [far] });
      expect(results).toHaveLength(0);
    });

    it('F7: the interactive path still widens an empty in-range answer to the full pool', async () => {
      mockAssayerRepo.query.mockResolvedValue([]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9 })]);
      const results = await engine.recommend(branch, new Date());
      expect(results.map((r) => r.assayer.id)).toEqual(['a-1']);
    });

    /**
     * F2: live location ranks, home prices. The ceiling warning and the home route are measured
     * from HOME even when the ranking used where the phone is now.
     */
    it('F2: a live-ranked candidate carries the home route, and the service-limit warning is measured from home', async () => {
      straightRouter();
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-live' }]);
      mockClientRepo.findOne.mockResolvedValue({ id: 'c-1', planningPreferences: { maxDistanceKm: 50 } });
      mockAssayerRepo.find.mockResolvedValue([active({
        id: 'a-live', displayName: 'Live Lata',
        latitude: 19.9, longitude: 73.85, // home ~153 km north
        isLiveEnabled: true, liveLatitude: 18.55, liveLongitude: 73.85, // phone ~3 km away
      })]);

      const [c] = await engine.recommend(branch, new Date()) as any[];
      expect(c.rankedFromLive).toBe(true);
      expect(c.route.distanceKm).toBeLessThan(10);
      expect(c.homeRoute.distanceKm).toBeGreaterThan(140);
      // The client's 50 km limit is exceeded from home, however close the phone is.
      expect(c.exceedsClientRange).toBe(50);
    });

    it('F2: for somebody ranked from home, the home route IS the route', async () => {
      straightRouter();
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-home' }]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-home', displayName: 'Home', latitude: 18.6, longitude: 73.85 })]);
      const [c] = await engine.recommend(branch, new Date()) as any[];
      expect(c.rankedFromLive).toBe(false);
      expect(c.homeRoute).toEqual(c.route);
    });

    /** F12: relaxed dates still say WHICH date check the candidate is on the list in spite of. */
    it('F12: with dates relaxed, an out-of-window date is reported on the row, not only leave', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9 })]);
      mockProjectBranchRepo.findOne.mockResolvedValue({ projectId: 'p-1', project: { startDate: '2030-01-01', endDate: '2030-12-31' } });
      const [c] = await engine.recommend(branch, new Date('2026-10-05T06:30:00Z'), {}, undefined, { relaxAvailability: true });
      expect(c.dateConflict).toMatch(/Timeline Conflict: .*before project start date 2030-01-01/);
    });

    /** Owner decision 2026-09-25: the client's required certifications EXCLUDE, with the reason named. */
    it('client requirements: a certification the client requires excludes, as SKILLS, naming it', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockClientRepo.findOne.mockResolvedValue({ id: 'c-1', planningPreferences: { requiredCertifications: ['XRF'] } });
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9 })]);
      const results = await engine.recommend(branch, new Date());
      expect(results).toHaveLength(0);
      const e = (results as any).excluded.find((x: any) => x.assayerId === 'a-1');
      expect(e).toMatchObject({ kind: 'SKILLS' });
      expect(e.detail).toMatch(/client requires.*XRF/);
    });

    it('client requirements: somebody holding a valid one passes', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockClientRepo.findOne.mockResolvedValue({ id: 'c-1', planningPreferences: { requiredCertifications: ['XRF'] } });
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9, certifications: [{ name: 'xrf', expiryDate: '2099-01-01' }] })]);
      expect((await engine.recommend(branch, new Date())).map((r) => r.assayer.id)).toEqual(['a-1']);
    });

    /** The rotation rule, from the shared helper, excludes with the audit named. */
    it('rotation: the last auditor from an earlier project is excluded as ROTATION, with the audit named', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'Ravi', latitude: 18.6, longitude: 73.9 })]);
      mockAssignmentRepo.query.mockImplementation(async (sql: string) =>
        (sql.includes('branch-rotation:last-auditor')
          ? [{ id: 'asn-old', assayer_id: 'a-1', project_id: 'p-before', status: 'COMPLETED', audit_date: '2026-03-10' }]
          : []));
      const results = await engine.recommend(branch, new Date(), {}, undefined, { projectId: 'p-now' });
      const e = (results as any).excluded.find((x: any) => x.assayerId === 'a-1');
      expect(e).toMatchObject({ kind: 'ROTATION' });
      expect(e.detail).toMatch(/Ravi audited this branch last \(2026-03-10\)/);
      const call = mockAssignmentRepo.query.mock.calls.find((c: any[]) => String(c[0]).includes('branch-rotation:last-auditor'));
      expect(call[1]).toEqual(['b-1', 'p-now']);
    });

    /** F9: delivery history is cut to 20 per assayer IN SQL, not loaded whole and trimmed. */
    it('F9: asks for at most 20 completed jobs per assayer with a window function', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9 })]);
      await engine.recommend(branch, new Date());
      const call = mockAssignmentRepo.query.mock.calls.find((c: any[]) => String(c[0]).includes('engine:delivery-history'));
      expect(call[0]).toMatch(/ROW_NUMBER\(\) OVER \(\s*PARTITION BY a\.assayer_id/);
      expect(call[0]).toMatch(/rn <= \$2/);
      expect(call[1]).toEqual([['a-1'], 20]);
    });

    /** F15: the delivery clock starts at the scheduled date (or check-in), not when the offer was made. */
    it('F15: a job completed on its scheduled day scores as same-day, however early it was offered', async () => {
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9 })]);
      mockAssignmentRepo.query.mockImplementation(async (sql: string) =>
        (sql.includes('engine:delivery-history')
          ? [{ assayer_id: 'a-1', completion_date: '2026-09-20', scheduled_date: '2026-09-20', checked_in_at: null }]
          : []));
      const [c] = await engine.recommend(branch, new Date());
      expect(c.breakdown.deliverySpeed).toBe(100);
    });

    /**
     * F16: the same-day grouping bonus counts only ASSIGNED work (never a declined or cancelled
     * row), and F14: acceptance divides by ANSWERED offers only.
     */
    it('F14/F16: the grouped reads ask for the right statuses', async () => {
      const calls: Array<[string, any]> = [];
      mockAssignmentRepo.createQueryBuilder.mockImplementation(() => {
        const b: any = groupedCountBuilder();
        b.andWhere = jest.fn((sql: string, params?: any) => { calls.push([sql, params]); return b; });
        return b;
      });
      mockAssayerRepo.query.mockResolvedValue([{ id: 'a-1' }]);
      mockAssayerRepo.find.mockResolvedValue([active({ id: 'a-1', displayName: 'One', latitude: 18.6, longitude: 73.9 })]);
      await engine.recommend(branch, new Date());

      const sameDay = calls.find(([, p]) => p?.sameDayStatuses)?.[1].sameDayStatuses;
      expect(sameDay).toEqual(expect.arrayContaining(['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']));
      expect(sameDay).not.toContain('REJECTED');
      expect(sameDay).not.toContain('CANCELLED');

      const answered = calls.find(([, p]) => p?.answered)?.[1].answered;
      expect(answered).toEqual(expect.arrayContaining(['ACCEPTED', 'REJECTED', 'COMPLETED']));
      expect(answered).not.toContain('PENDING');
      expect(answered).not.toContain('CANCELLED');
    });
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
  /**
   * The rule reads the branch's last auditor through `findLastBranchAuditor` — the same helper the
   * assignment write path enforces with. The query itself only returns an ACCEPTED/CHECKED_IN/
   * IN_PROGRESS/COMPLETED row from a DIFFERENT project; these tests pin both what the SQL asks and
   * what the filter does with the answer.
   */
  const mockAssignmentRepo = { query: jest.fn() };

  // Rules are enforced unless an administrator has suspended them — see
  // modules/platform/rule-bypass. Nothing is suspended in these tests, which is the state
  // the rotation rule is actually asserting about.
  const noBypass = { isBypassedSync: () => false, isBypassed: async () => false, noteBypass: () => undefined } as any;
  const filter = new ConsecutiveBranchAuditFilter(mockAssignmentRepo as any, noBypass);

  const branch = { id: 'branch-1' } as any;
  const assayer = { id: 'assayer-1', displayName: 'Ravi' } as any;
  const context: any = { branch, client: null, scheduledDate: new Date(), weights: {}, projectId: 'project-now' };
  const row = (assayerId: string, status: AssignmentStatus) => [{ id: 'asn-old', assayer_id: assayerId, project_id: 'project-before', status, audit_date: '2026-03-10' }];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows the candidate through when nobody has audited this branch before', async () => {
    mockAssignmentRepo.query.mockResolvedValue([]);
    await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
  });

  it('asks only for engaged audits (never pending, declined or cancelled) from an EARLIER project', async () => {
    mockAssignmentRepo.query.mockResolvedValue([]);
    await filter.evaluate(assayer, context);
    const [sql, params] = mockAssignmentRepo.query.mock.calls[0];
    for (const s of ['ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) expect(sql).toContain(`'${s}'`);
    for (const s of ['PENDING', 'REJECTED', 'CANCELLED']) expect(sql).not.toContain(`'${s}'`);
    expect(sql).toMatch(/project_id IS DISTINCT FROM \$2/);
    expect(params).toEqual(['branch-1', 'project-now']);
  });

  it.each([AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED])(
    'excludes the last auditor whose earlier audit is %s',
    async (status) => {
      mockAssignmentRepo.query.mockResolvedValue(row('assayer-1', status));
      await expect(filter.evaluate(assayer, context)).resolves.toBe(false);
    },
  );

  it('does not exclude a different assayer', async () => {
    mockAssignmentRepo.query.mockResolvedValue(row('someone-else', AssignmentStatus.COMPLETED));
    await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
  });

  it('names the audit that made them the last auditor', async () => {
    mockAssignmentRepo.query.mockResolvedValue(row('assayer-1', AssignmentStatus.COMPLETED));
    await expect(filter.explain(assayer, context)).resolves.toMatch(/Ravi audited this branch last \(2026-03-10\)/);
  });

  it('uses the pool-wide answer recommend() resolved, without querying again', async () => {
    const withFacts = { ...context, branchFacts: { lastAuditor: { assayerId: 'assayer-1', status: AssignmentStatus.COMPLETED, assignmentId: 'x', projectId: 'p', auditDate: null } } };
    await expect(filter.evaluate(assayer, withFacts)).resolves.toBe(false);
    expect(mockAssignmentRepo.query).not.toHaveBeenCalled();
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

/**
 * `riskScore` is 0–10 (the importer writes LOW 2 / MEDIUM 4 / HIGH 7 / CRITICAL 9, and the
 * planning map reads >= 7 as high). This calculator used to test `risk < 50` — a 0–100 threshold
 * the data never used — so it returned 100 for every branch and never told a critical branch from
 * a trivial one.
 */
describe('RiskScoreCalculator — reads the 0–10 scale the data is actually on', () => {
  const calc = new RiskScoreCalculator();
  const ctx = (riskScore: number) =>
    ({ branch: { id: 'b', riskScore } as any, client: null, scheduledDate: new Date(), weights: {} }) as any;
  const junior = { id: 'a-junior', experienceYears: 1, performanceRating: 4.0 } as any;
  const senior = { id: 'a-senior', experienceYears: 6, performanceRating: 4.8 } as any;

  it('lets anyone take a LOW or MEDIUM branch', async () => {
    await expect(calc.calculate(junior, ctx(2))).resolves.toBe(100);
    await expect(calc.calculate(junior, ctx(4))).resolves.toBe(100);
  });

  it('prefers a senior assayer for a HIGH branch and penalises a junior by ten points per risk point', async () => {
    await expect(calc.calculate(senior, ctx(7))).resolves.toBe(100);
    await expect(calc.calculate(junior, ctx(7))).resolves.toBe(30);
  });

  it('nearly zeroes a junior on a CRITICAL branch without disqualifying them outright', async () => {
    await expect(calc.calculate(senior, ctx(9))).resolves.toBe(100);
    await expect(calc.calculate(junior, ctx(9))).resolves.toBe(10);
  });
});

/**
 * `branch.city` is free text carried through from address parsing, not a canonical name — live
 * data holds "Pune" AND "Pune City" for the same metro, and "Mumbai City" alongside what would
 * otherwise match "mumbai". An exact-string lookup against the tier lists silently missed both:
 * on the live dev deployment this meant every Pune branch (all city-labelled "Pune City") priced
 * as if it were an untiered town, understating CostScoreCalculator's fee for every candidate
 * there. Confirmed against `SELECT DISTINCT city FROM branches` on that database, which returned
 * exactly this set.
 */
describe('getCityTierMultiplier — city is free text, not a canonical key', () => {
  it('matches a bare tier-1 or tier-2 name', () => {
    expect(getCityTierMultiplier('Pune')).toBe(1.5);
    expect(getCityTierMultiplier('Nashik')).toBe(1.2);
  });

  it('still matches with a trailing "City" — the variant actually seen in production data', () => {
    expect(getCityTierMultiplier('Pune City')).toBe(1.5);
    expect(getCityTierMultiplier('Mumbai City')).toBe(1.5);
  });

  it('is case- and whitespace-insensitive on both the name and the suffix', () => {
    expect(getCityTierMultiplier('  PUNE CITY  ')).toBe(1.5);
    expect(getCityTierMultiplier('pune city')).toBe(1.5);
  });

  it('does not invent a tier for an untiered town, with or without the suffix', () => {
    expect(getCityTierMultiplier('Solapur')).toBe(1.0);
    expect(getCityTierMultiplier('Solapur City')).toBe(1.0);
  });

  it('falls back to 1.0 with no city at all', () => {
    expect(getCityTierMultiplier(undefined)).toBe(1.0);
    expect(getCityTierMultiplier('')).toBe(1.0);
  });
});

/**
 * Found live 2026-09-04 (Track S): this filter only ever called checkDoubleBooking and
 * checkLeaves — checkHoliday and checkProjectTimeline were never reached, even though both are
 * real and are enforced a moment later at assignment-creation time. Confirmed live: a real,
 * active Maharashtra state holiday (Ganesh Chaturthi, 2026-09-14) produced zero DATE-kind
 * exclusions on a real branch's candidate list; re-verified live immediately after this fix —
 * the same call now produces 49 DATE-kind exclusions on that exact date.
 */
describe('AvailabilityFilter', () => {
  const passResult = { passed: true };
  const failResult = { passed: false, reason: 'blocked' };
  const branch = { id: 'branch-1', state: 'Maharashtra' } as any;
  const client = { id: 'client-1' } as any;
  const assayer = { id: 'assayer-1' } as any;
  const scheduledDate = new Date('2026-09-14');

  const mockConstraintEvaluator = {
    checkHoliday: jest.fn(),
    checkProjectTimeline: jest.fn(),
    checkLeaves: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConstraintEvaluator.checkHoliday.mockResolvedValue(passResult);
    mockConstraintEvaluator.checkProjectTimeline.mockReturnValue(passResult);
    mockConstraintEvaluator.checkLeaves.mockReturnValue(passResult);
  });

  it('excludes a candidate when branchFacts.holidayResult failed — the bug this test pins', async () => {
    const filter = new AvailabilityFilter(mockConstraintEvaluator);
    const context: any = {
      branch, client, scheduledDate, weights: {},
      branchFacts: {
        holidayResult: failResult,
        timelineResult: passResult,
      },
    };

    expect(await filter.evaluate(assayer, context)).toBe(false);
    // The whole point of hoisting into branchFacts: no per-candidate query for a fact that
    // does not depend on the candidate.
    expect(mockConstraintEvaluator.checkHoliday).not.toHaveBeenCalled();
  });

  it('excludes a candidate when branchFacts.timelineResult failed', async () => {
    const filter = new AvailabilityFilter(mockConstraintEvaluator);
    const context: any = {
      branch, client, scheduledDate, weights: {},
      branchFacts: {
        holidayResult: passResult,
        timelineResult: failResult,
      },
    };

    expect(await filter.evaluate(assayer, context)).toBe(false);
  });

  it('admits a candidate when every branchFacts date check passed', async () => {
    const filter = new AvailabilityFilter(mockConstraintEvaluator);
    const context: any = {
      branch, client, scheduledDate, weights: {},
      branchFacts: {
        holidayResult: passResult,
        timelineResult: passResult,
      },
    };

    expect(await filter.evaluate(assayer, context)).toBe(true);
  });

  it('falls back to a live checkHoliday call when branchFacts is absent (standalone use)', async () => {
    const filter = new AvailabilityFilter(mockConstraintEvaluator);
    mockConstraintEvaluator.checkHoliday.mockResolvedValue(failResult);
    const context: any = { branch, client, scheduledDate, weights: {} };

    expect(await filter.evaluate(assayer, context)).toBe(false);
    expect(mockConstraintEvaluator.checkHoliday).toHaveBeenCalledWith('Maharashtra', scheduledDate, 'client-1');
  });

  /**
   * Owner decision 2026-09-24 (E2): several branches per assayer per day. Somebody already booked
   * that day is still available — the filter has no booking check to consult at all.
   */
  it('admits a candidate who already holds another branch that day', async () => {
    const filter = new AvailabilityFilter(mockConstraintEvaluator);
    const context: any = {
      branch, client, scheduledDate, weights: {},
      branchFacts: { holidayResult: passResult, timelineResult: passResult, sameDayBranchPointsByAssayer: { 'assayer-1': [{ latitude: 1, longitude: 1 }] } },
    };
    expect(await filter.evaluate(assayer, context)).toBe(true);
    expect(await filter.exclusionReason(assayer, context)).toBeNull();
  });

  it('relaxAvailability skips every date check, including the two just added', async () => {
    const filter = new AvailabilityFilter(mockConstraintEvaluator);
    const context: any = {
      branch, client, scheduledDate, weights: {}, relaxAvailability: true,
      branchFacts: { holidayResult: failResult, timelineResult: failResult },
    };

    expect(await filter.evaluate(assayer, context)).toBe(true);
  });
});

/** F14: accepted ÷ ANSWERED — a pending or desk-cancelled offer is not a "no". */
describe('acceptanceRateScore', () => {
  it('is 85 for somebody who has answered nothing yet', () => {
    expect(acceptanceRateScore(0, 0)).toBe(85);
  });
  it('divides accepted by answered', () => {
    expect(acceptanceRateScore(4, 3)).toBe(75);
  });
  it('the answered set is yes-or-no only', () => {
    expect(ANSWERED_OFFER_STATUSES).not.toContain(AssignmentStatus.PENDING);
    expect(ANSWERED_OFFER_STATUSES).not.toContain(AssignmentStatus.CANCELLED);
    expect(ANSWERED_OFFER_STATUSES).toContain(AssignmentStatus.REJECTED);
  });
});

/** F15: delivery measured from when the work could start (check-in, else the scheduled day). */
describe('deliveryDays / deliverySpeedScore', () => {
  it('counts calendar days from the scheduled date to completion', () => {
    expect(deliveryDays({ completionDate: '2026-09-22', scheduledDate: '2026-09-20' })).toBe(2);
  });
  it('prefers the check-in day when there is one', () => {
    expect(deliveryDays({ completionDate: '2026-09-22', scheduledDate: '2026-09-10', checkedInAt: '2026-09-22T04:00:00Z' })).toBe(0);
  });
  it('a check-in alone is enough to start the clock', () => {
    expect(deliveryDays({ completionDate: '2026-09-23', scheduledDate: null, checkedInAt: '2026-09-22T04:00:00Z' })).toBe(1);
  });
  it('is unmeasurable without a start or an end', () => {

    expect(deliveryDays({ completionDate: null, scheduledDate: '2026-09-10' })).toBeNull();
    expect(deliveryDays({ completionDate: '2026-09-10', scheduledDate: null })).toBeNull();
  });
  it('scores same day 100, next day 80, two days 60, later 40, unmeasurable 75', () => {
    const r = (c: string, s: string | null) => ({ completionDate: c, scheduledDate: s });
    expect(deliverySpeedScore([r('2026-09-10', '2026-09-10')])).toBe(100);
    expect(deliverySpeedScore([r('2026-09-11', '2026-09-10')])).toBe(80);
    expect(deliverySpeedScore([r('2026-09-12', '2026-09-10')])).toBe(60);
    expect(deliverySpeedScore([r('2026-09-20', '2026-09-10')])).toBe(40);
    expect(deliverySpeedScore([r('2026-09-20', null)])).toBe(75);
    expect(deliverySpeedScore([])).toBe(80);
  });
});
