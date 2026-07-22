import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  RecommendationEngine,
  AvailabilityFilter,
  ClientRestrictionFilter,
  ClientEligibilityFilter,
  RuleEngineEligibilityFilter,
  DistanceScoreCalculator,
  TravelTimeScoreCalculator,
  WorkloadScoreCalculator,
  PerformanceScoreCalculator,
  ExperienceScoreCalculator,
  CostScoreCalculator,
  ClientPreferenceScoreCalculator,
  BranchFamiliarityScoreCalculator,
  SLAComplianceScoreCalculator,
  ProfitabilityScoreCalculator,
  RiskScoreCalculator,
} from './recommendation.engine';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { RoutingService } from '../geo/routing.provider';
import { AssayerCommercialProfileEntity } from '../assayer/assayer-commercial-profile.entity';
import { ClientEntity } from '../client/client.entity';
import { RuleEngine } from '../platform/rules/rule.engine';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';

describe('RecommendationEngine', () => {
  let engine: RecommendationEngine;

  const mockAssayerRepo = {
    find: jest.fn(),
  };

  const mockAssignmentRepo = {
    findOne: jest.fn(),
    count: jest.fn(),
  };

  const mockCommercialRepo = {
    find: jest.fn(),
  };

  const mockClientRepo = {
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
        ClientRestrictionFilter,
        ClientEligibilityFilter,
        RuleEngineEligibilityFilter,
        DistanceScoreCalculator,
        TravelTimeScoreCalculator,
        WorkloadScoreCalculator,
        PerformanceScoreCalculator,
        ExperienceScoreCalculator,
        CostScoreCalculator,
        ClientPreferenceScoreCalculator,
        BranchFamiliarityScoreCalculator,
        SLAComplianceScoreCalculator,
        ProfitabilityScoreCalculator,
        RiskScoreCalculator,
        ConfigurationResolver,
        {
          provide: getRepositoryToken(AssayerEntity),
          useValue: mockAssayerRepo,
        },
        {
          provide: getRepositoryToken(AssignmentEntity),
          useValue: mockAssignmentRepo,
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
          provide: RoutingService,
          useValue: mockRoutingService,
        },
        {
          provide: RuleEngine,
          useValue: mockRuleEngine,
        },
      ],
    }).compile();

    engine = module.get<RecommendationEngine>(RecommendationEngine);
    jest.clearAllMocks();
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
});
