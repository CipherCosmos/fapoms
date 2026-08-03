"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const shared_1 = require("@fapoms/shared");
const recommendation_engine_1 = require("./recommendation.engine");
const assayer_entity_1 = require("../assayer/assayer.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const routing_provider_1 = require("../geo/routing.provider");
const assayer_commercial_profile_entity_1 = require("../assayer/assayer-commercial-profile.entity");
const client_entity_1 = require("../client/client.entity");
const project_branch_entity_1 = require("../project/project-branch.entity");
const rule_engine_1 = require("../platform/rules/rule.engine");
const configuration_resolver_1 = require("../platform/configuration/configuration.resolver");
const constraint_evaluator_1 = require("./constraint.evaluator");
const assayer_service_1 = require("../assayer/assayer.service");
const holiday_service_1 = require("../holiday/holiday.service");
const schedule_entity_1 = require("../scheduling/schedule.entity");
const validation_query_entity_1 = require("../validation-query/validation-query.entity");
describe('RecommendationEngine', () => {
    let engine;
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
    };
    const mockCommercialRepo = {
        find: jest.fn(),
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
        const module = await testing_1.Test.createTestingModule({
            providers: [
                recommendation_engine_1.RecommendationEngine,
                recommendation_engine_1.AvailabilityFilter,
                recommendation_engine_1.ConsecutiveBranchAuditFilter,
                recommendation_engine_1.ClientRestrictionFilter,
                recommendation_engine_1.ClientEligibilityFilter,
                recommendation_engine_1.RuleEngineEligibilityFilter,
                recommendation_engine_1.RequiredSkillsFilter,
                recommendation_engine_1.DistanceScoreCalculator,
                recommendation_engine_1.TravelTimeScoreCalculator,
                recommendation_engine_1.WorkloadScoreCalculator,
                recommendation_engine_1.PerformanceScoreCalculator,
                recommendation_engine_1.RejectionAcceptanceScoreCalculator,
                recommendation_engine_1.DeliverySpeedScoreCalculator,
                recommendation_engine_1.QueryVolumeScoreCalculator,
                recommendation_engine_1.ExperienceScoreCalculator,
                recommendation_engine_1.CostScoreCalculator,
                recommendation_engine_1.ClientPreferenceScoreCalculator,
                recommendation_engine_1.BranchFamiliarityScoreCalculator,
                recommendation_engine_1.SLAComplianceScoreCalculator,
                recommendation_engine_1.CustomerDensityScoreCalculator,
                recommendation_engine_1.ProfitabilityScoreCalculator,
                recommendation_engine_1.RiskScoreCalculator,
                configuration_resolver_1.ConfigurationResolver,
                constraint_evaluator_1.ConstraintEvaluator,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assayer_entity_1.AssayerEntity),
                    useValue: mockAssayerRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity),
                    useValue: mockAssignmentRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(schedule_entity_1.ScheduleEntity),
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
                    provide: (0, typeorm_1.getRepositoryToken)(project_branch_entity_1.ProjectBranchEntity),
                    useValue: mockProjectBranchRepo,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(validation_query_entity_1.ValidationQueryEntity),
                    useValue: { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) },
                },
                {
                    provide: routing_provider_1.RoutingService,
                    useValue: mockRoutingService,
                },
                {
                    provide: rule_engine_1.RuleEngine,
                    useValue: mockRuleEngine,
                },
                {
                    provide: assayer_service_1.AssayerService,
                    useValue: mockAssayerService,
                },
                {
                    provide: holiday_service_1.HolidayService,
                    useValue: mockHolidayService,
                },
                {
                    provide: holiday_service_1.HolidayService,
                    useValue: {},
                },
            ],
        }).compile();
        engine = module.get(recommendation_engine_1.RecommendationEngine);
        mockAssignmentRepo.find.mockResolvedValue([]);
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
        mockAssignmentRepo.findOne.mockImplementation(async (opts) => {
            if (opts?.where?.status === shared_1.AssignmentStatus.PENDING) {
                return { assayerId: 'a-pending', projectBranch: { branchId: 'b-1' } };
            }
            return null;
        });
        const branch = { id: 'b-1', latitude: 19.076, longitude: 72.877 };
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
        };
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
    const calculator = new recommendation_engine_1.BranchFamiliarityScoreCalculator(mockAssignmentRepo);
    const branch = { id: 'branch-1', latitude: 19.076, longitude: 72.877 };
    const assayer = { id: 'assayer-1' };
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it('scores an assayer with no prior visits to this branch at the baseline', async () => {
        mockAssignmentRepo.count.mockResolvedValue(0);
        const score = await calculator.calculate(assayer, { branch, client: null, scheduledDate: new Date(), weights: {} });
        expect(score).toBe(50);
        expect(mockAssignmentRepo.count).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                assayerId: 'assayer-1',
                projectBranch: { branchId: 'branch-1' },
            }),
        }));
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
    const filter = new recommendation_engine_1.ConsecutiveBranchAuditFilter(mockAssignmentRepo);
    const branch = { id: 'branch-1' };
    const assayer = { id: 'assayer-1' };
    const context = { branch, client: null, scheduledDate: new Date(), weights: {} };
    beforeEach(() => {
        jest.clearAllMocks();
    });
    it('allows the candidate through when there is no prior assignment on this branch', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue(null);
        await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
    });
    it('does NOT exclude the assayer whose offer on this branch is still PENDING', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: shared_1.AssignmentStatus.PENDING });
        await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
    });
    it('excludes the assayer once their assignment on this branch is ACCEPTED', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: shared_1.AssignmentStatus.ACCEPTED });
        await expect(filter.evaluate(assayer, context)).resolves.toBe(false);
    });
    it('excludes the assayer who already COMPLETED the last audit of this branch', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: shared_1.AssignmentStatus.COMPLETED });
        await expect(filter.evaluate(assayer, context)).resolves.toBe(false);
    });
    it('does not exclude a different assayer even if the last assignment was ACCEPTED', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'someone-else', status: shared_1.AssignmentStatus.ACCEPTED });
        await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
    });
    it('does not exclude the assayer whose prior offer on this branch was REJECTED', async () => {
        mockAssignmentRepo.findOne.mockResolvedValue({ assayerId: 'assayer-1', status: shared_1.AssignmentStatus.REJECTED });
        await expect(filter.evaluate(assayer, context)).resolves.toBe(true);
    });
});
//# sourceMappingURL=recommendation.engine.spec.js.map