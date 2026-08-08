import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { RecommendationEngine } from './recommendation.engine';
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

  const mockAssayerService = {
    getActiveCommercialProfile: mockCommercialRepo.findOne,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningService,
        {
          provide: FeePolicyService,
          useValue: {
            // Mirrors the real service: a client rate card when configured, platform defaults
            // otherwise, and a base fee resolved for the date the candidate is scored on.
            getRates: jest.fn().mockResolvedValue({ travelFeePerKm: 8, freeTravelAllowanceKm: 10, defaultBaseFee: 1200, clientConfigured: false }),
            resolveBaseFee: jest.fn().mockResolvedValue({ baseFee: 1500, usedFallback: false }),
          },
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
    });

    const results = await service.getRecommendedCandidates('b-1');

    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('John Doe');
    expect(results[0].readableReasons).toBeDefined();
    expect(results[0].readableReasons!.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('a-1');
    expect(results[0].distanceKm).toBe(5.5);
    expect(results[0].score).toBe(95.5);
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
});
