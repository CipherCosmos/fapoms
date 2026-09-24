import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { RecommendationEngine } from './recommendation.engine';
import { ConstraintEvaluator } from './constraint.evaluator';
import { RoutingService } from '../geo/routing.provider';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';
import { BranchQueryService } from '../branch/branch-query.service';
import { AssayerService } from '../assayer/assayer.service';
import { AuditService } from '../../core/audit/audit.service';
import { FeePolicyService } from '../pricing/fee-policy.service';

describe('PlanningService', () => {
  let service: PlanningService;
  let recommendationEngine: RecommendationEngine;

  const mockBranchRepository = {
    findOne: jest.fn(),
  };

  const mockBranchQueryService = {
    findOne: mockBranchRepository.findOne,
  };

  const mockRecommendationEngine = {
    recommend: jest.fn(),
  };

  const mockRoutingService = {
    calculateRoute: jest.fn(),
  };

  const mockRuleRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockCommercialRepo = {
    findOne: jest.fn(),
  };

  const mockFeePolicyService = {
    // Mirrors the real service: a client rate card when configured, platform defaults
    // otherwise, and a base fee resolved for the date the candidate is scored on.
    getRates: jest.fn().mockResolvedValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: false }),
    resolveBaseFee: jest.fn().mockResolvedValue({ baseFee: 1500, usedFallback: false }),
    // Batched variant: the candidate list resolves every ranked assayer's rate in one
    // query. Same rule as resolveBaseFee, so the stub mirrors it per id.
    resolveBaseFees: jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { baseFee: 1500, usedFallback: false }]))),
  };

  const mockAssayerService = {
    getActiveCommercialProfile: mockCommercialRepo.findOne,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningService,
        {
          provide: FeePolicyService,
          useValue: mockFeePolicyService,
        },
        { provide: AuditService, useValue: { recordEvent: jest.fn().mockResolvedValue(undefined) , recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); })} },
        {
          provide: BranchQueryService,
          useValue: mockBranchQueryService,
        },
        {
          provide: getRepositoryToken(BusinessRuleEntity),
          useValue: mockRuleRepository,
        },
        {
          provide: AssayerService,
          useValue: mockAssayerService,
        },
        {
          provide: RecommendationEngine,
          useValue: mockRecommendationEngine,
        },
        {
          provide: RoutingService,
          useValue: mockRoutingService,
        },
        {
          provide: ConstraintEvaluator,
          // Every day is a working day unless a test says otherwise.
          useValue: { checkHoliday: jest.fn().mockResolvedValue({ passed: true }) },
        },
      ],
    }).compile();

    service = module.get<PlanningService>(PlanningService);
    recommendationEngine = module.get<RecommendationEngine>(RecommendationEngine);

    mockCommercialRepo.findOne.mockResolvedValue({ baseFee: 1500 });
    jest.clearAllMocks();
  });

  it('should throw NotFoundException if branch is missing', async () => {
    mockBranchRepository.findOne.mockResolvedValue(null);

    await expect(service.getRecommendedCandidates('missing-id')).rejects.toThrow(NotFoundException);
  });

  it('should return recommended candidates correctly', async () => {
    const mockBranch = {
      id: 'b-1',
      latitude: 19.076,
      longitude: 72.8777,
    };
    mockBranchRepository.findOne.mockResolvedValue(mockBranch);

    const mockAssayer = {
      id: 'a-1',
      assayerCode: 'AS-1',
      displayName: 'John Doe',
      phone: '1234567890',
      email: 'john@example.com',
      status: 'ACTIVE',
      state: 'MH',
      district: 'Mumbai',
      city: 'Mumbai',
      latitude: 19.082,
      longitude: 72.882,
      // Mirrors the AssayerEntity getters the service now reads. A plain fixture object
      // doesn't inherit them, so without these the assayer maps to 0,0.
      effectiveLatitude: 19.082,
      effectiveLongitude: 72.882,
    };
    mockRecommendationEngine.recommend.mockResolvedValue([
      {
        assayer: mockAssayer,
        score: 95.5,
        breakdown: { distance: 95, workload: 100 },
      },
    ]);

    mockRoutingService.calculateRoute.mockResolvedValue({
      distanceKm: 5.5,
      durationMinutes: 12,
      source: 'OSRM',
    });

    const results = await service.getRecommendedCandidates('b-1');

    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('John Doe');
    expect(results[0].readableReasons).toBeDefined();
    expect(results[0].readableReasons!.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('a-1');
    expect(results[0].distanceKm).toBe(5.5);
    expect(results[0].score).toBe(95.5);
    // The label travels with the figure, and the sentence a person reads says how it was
    // measured — an estimate must never be presented as a road figure.
    expect(results[0].distanceSource).toBe('OSRM');
    expect(results[0].durationMinutes).toBe(12);
    expect(results[0].readableReasons!.map((r) => r.message).join(' ')).toContain('5.5 km by road');
  });

  it('labels a straight-line fallback as an estimate everywhere it is shown', async () => {
    mockBranchRepository.findOne.mockResolvedValue({ id: 'b-1', latitude: 19.076, longitude: 72.8777 });
    mockRecommendationEngine.recommend.mockResolvedValue([
      {
        assayer: {
          id: 'a-2', assayerCode: 'AS-2', displayName: 'Far Away', phone: null, email: null,
          status: 'ACTIVE', state: 'MH', district: 'Nashik', city: 'Nashik',
          effectiveLatitude: 20.0, effectiveLongitude: 73.8,
        },
        score: 40,
        breakdown: { distance: 20 },
        // The engine hands back the route it scored with; here the router was down.
        route: { distanceKm: 164.4, durationMinutes: 246.6, source: 'ESTIMATE' },
      },
    ]);

    const results = await service.getRecommendedCandidates('b-1');

    expect(results[0].distanceKm).toBe(164.4);
    expect(results[0].distanceSource).toBe('ESTIMATE');
    expect(results[0].readableReasons!.map((r) => r.message).join(' ')).toContain('~164 km (straight line, estimate)');
    // The engine's route was reused — no second lookup for the same pair.
    expect(mockRoutingService.calculateRoute).not.toHaveBeenCalled();
  });

  it('flags a fallback base fee so the UI can tell a platform guess from a real contracted rate', async () => {
    mockBranchRepository.findOne.mockResolvedValue({ id: 'b-1', latitude: 19.076, longitude: 72.8777 });
    mockRecommendationEngine.recommend.mockResolvedValue([
      {
        assayer: {
          id: 'a-3', assayerCode: 'AS-3', displayName: 'No Contract', phone: null, email: null,
          status: 'ACTIVE', state: 'MH', district: 'Pune', city: 'Pune',
          effectiveLatitude: 18.5, effectiveLongitude: 73.8,
        },
        score: 50,
        breakdown: { distance: 50 },
      },
    ]);
    // FeePolicyService itself already knows this candidate has no priced profile — it resolved
    // to the platform-wide default. This used to be computed and thrown away right here.
    mockFeePolicyService.resolveBaseFees.mockResolvedValueOnce(
      new Map([['a-3', { baseFee: 1200, usedFallback: true }]]) as any,
    );

    const results = await service.getRecommendedCandidates('b-1');

    expect(results[0].baseFee).toBe(1200);
    expect(results[0].usedFallbackBaseFee).toBe(true);
  });

  it('does not flag a real, priced base fee as a fallback', async () => {
    mockBranchRepository.findOne.mockResolvedValue({ id: 'b-1', latitude: 19.076, longitude: 72.8777 });
    mockRecommendationEngine.recommend.mockResolvedValue([
      {
        assayer: {
          id: 'a-1', assayerCode: 'AS-1', displayName: 'John Doe', phone: null, email: null,
          status: 'ACTIVE', state: 'MH', district: 'Mumbai', city: 'Mumbai',
          effectiveLatitude: 19.082, effectiveLongitude: 72.882,
        },
        score: 95.5,
        breakdown: { distance: 95 },
      },
    ]);
    // The default mock from beforeEach: usedFallback: false, a real contracted rate.

    const results = await service.getRecommendedCandidates('b-1');

    expect(results[0].baseFee).toBe(1500);
    expect(results[0].usedFallbackBaseFee).toBe(false);
  });

  // Business Rule test coverage
  it('should create a business rule correctly', async () => {
    const dto = {
      name: 'Req Skill',
      scope: 'GLOBAL',
      ruleType: 'SKILL',
      conditions: { requiredSkill: 'Gold' },
    };
    mockRuleRepository.create.mockReturnValue(dto);
    mockRuleRepository.save.mockResolvedValue({ id: 'r-1', ...dto });

    const rule = await service.createRule(dto, 'u-1');
    expect(rule.id).toBe('r-1');
    expect(rule.name).toBe('Req Skill');
  });

  it('should throw NotFoundException on update if rule does not exist', async () => {
    mockRuleRepository.findOne.mockResolvedValue(null);
    await expect(service.updateRule('missing', {}, 'u-1')).rejects.toThrow(NotFoundException);
  });

  /** The 2026-09-25 recommendations audit. */
  describe('audit 2026-09-25', () => {
    const branch = { id: 'b-1', latitude: 18.5, longitude: 73.8, clientId: null, state: 'Maharashtra' };
    const ranked = (n: number) => Object.assign(
      Array.from({ length: n }, (_, i) => ({
        assayer: { id: `a-${i}`, displayName: `A${i}`, homeLatitude: 18.6, homeLongitude: 73.9, effectiveLatitude: 18.6, effectiveLongitude: 73.9 },
        score: 100 - i * 0.1, breakdown: {}, contribution: {},
        route: { distanceKm: 6, durationMinutes: 12, source: 'OSRM' },
        homeRoute: { distanceKm: 140, durationMinutes: 170, source: 'OSRM' },
        rankedFromLive: i === 0,
      })),
      { excluded: [] },
    );

    /** F9: the API returns the top N and says how many were ranked. */
    it('F9: returns at most 100 candidates, and reports how many were ranked', async () => {
      mockBranchRepository.findOne.mockResolvedValue(branch);
      mockRecommendationEngine.recommend.mockResolvedValue(ranked(250));
      const out = await service.getRecommendedCandidates('b-1');
      expect(out).toHaveLength(100);
      expect((out as any).candidateTotal).toBe(250);
      // Fees are resolved for the returned rows only.
      expect((mockFeePolicyService.resolveBaseFees.mock.calls.at(-1) as any)[0]).toHaveLength(100);
    });

    /** F2: the card carries the HOME figures the job is priced from, beside the ranked ones. */
    it('F2: carries the home distance and says the ranking was live', async () => {
      mockBranchRepository.findOne.mockResolvedValue(branch);
      mockRecommendationEngine.recommend.mockResolvedValue(ranked(2));
      const [live, home] = await service.getRecommendedCandidates('b-1');
      expect(live).toMatchObject({ distanceKm: 6, homeDistanceKm: 140, homeDurationMinutes: 170, homeDistanceSource: 'OSRM', rankedFromLive: true });
      expect(home.rankedFromLive).toBe(false);
    });

    it('passes the project through to the engine', async () => {
      mockBranchRepository.findOne.mockResolvedValue(branch);
      mockRecommendationEngine.recommend.mockResolvedValue(ranked(1));
      await service.getRecommendedCandidates('b-1', {}, '2026-10-05', { projectId: 'p-1' });
      const [, day, , , options] = mockRecommendationEngine.recommend.mock.calls.at(-1) as any[];
      expect(options).toEqual({ projectId: 'p-1' });
      // The requested calendar day, whatever zone reads it (F20).
      expect((day as Date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })).toBe('2026-10-05');
    });

    /**
     * F20: the suggested date is stepped on the IST calendar. Faked at 01:00 IST on a Saturday
     * (19:30 UTC the day before): "tomorrow" is Sunday the 4th in India — skipped — so Monday the 5th.
     */
    it('F20: suggests from the IST calendar, skipping an IST Sunday', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-02T19:30:00Z') }); // Sat 3 Oct, 01:00 IST
      try {
        mockBranchRepository.findOne.mockResolvedValue(branch);
        const out = await service.suggestAuditDate('b-1');
        expect(out.skipped[0]).toEqual({ date: '2026-10-04', reason: 'Sunday' });
        expect(out.date).toBe('2026-10-05');
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
