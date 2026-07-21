import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { BranchEntity } from '../branch/branch.entity';
import { RecommendationEngine } from './recommendation.engine';
import { RoutingService } from '../geo/routing.provider';
import { BusinessRuleEntity } from '../platform/rules/business-rule.entity';

describe('PlanningService', () => {
  let service: PlanningService;
  let recommendationEngine: RecommendationEngine;

  const mockBranchRepository = {
    findOne: jest.fn(),
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningService,
        {
          provide: getRepositoryToken(BranchEntity),
          useValue: mockBranchRepository,
        },
        {
          provide: getRepositoryToken(BusinessRuleEntity),
          useValue: mockRuleRepository,
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
