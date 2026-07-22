"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const recommendation_engine_1 = require("./recommendation.engine");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const routing_provider_1 = require("../geo/routing.provider");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const client_entity_1 = require("../client/client.entity");
const rule_engine_1 = require("../platform/rules/rule.engine");
const configuration_resolver_1 = require("../platform/configuration/configuration.resolver");
describe('RecommendationEngine', () => {
    let engine;
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
        const module = await testing_1.Test.createTestingModule({
            providers: [
                recommendation_engine_1.RecommendationEngine,
                recommendation_engine_1.AvailabilityFilter,
                recommendation_engine_1.ClientRestrictionFilter,
                recommendation_engine_1.ClientEligibilityFilter,
                recommendation_engine_1.RuleEngineEligibilityFilter,
                recommendation_engine_1.DistanceScoreCalculator,
                recommendation_engine_1.TravelTimeScoreCalculator,
                recommendation_engine_1.WorkloadScoreCalculator,
                recommendation_engine_1.PerformanceScoreCalculator,
                recommendation_engine_1.ExperienceScoreCalculator,
                recommendation_engine_1.CostScoreCalculator,
                recommendation_engine_1.ClientPreferenceScoreCalculator,
                recommendation_engine_1.BranchFamiliarityScoreCalculator,
                recommendation_engine_1.SLAComplianceScoreCalculator,
                recommendation_engine_1.ProfitabilityScoreCalculator,
                recommendation_engine_1.RiskScoreCalculator,
                configuration_resolver_1.ConfigurationResolver,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assayer_entity_1.AssayerEntity),
                    useValue: mockAssayerRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity),
                    useValue: mockAssignmentRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assayer_commercial_profile_entity_1.AssayerCommercialProfileEntity),
                    useValue: mockCommercialRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(client_entity_1.ClientEntity),
                    useValue: mockClientRepo,
                },
                {
                    provide: routing_provider_1.RoutingService,
                    useValue: mockRoutingService,
                },
                {
                    provide: rule_engine_1.RuleEngine,
                    useValue: mockRuleEngine,
                },
            ],
        }).compile();
        engine = module.get(recommendation_engine_1.RecommendationEngine);
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
        };
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
        };
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
        };
        const results = await engine.recommend(branch, new Date());
        expect(results).toHaveLength(2);
        expect(results[0].assayer.id).toBe('a-close');
        expect(results[0].score).toBeGreaterThan(results[1].score);
    });
});
//# sourceMappingURL=recommendation.engine.spec.js.map