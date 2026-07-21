"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const planning_service_1 = require("./planning.service");
const branch_entity_1 = require("../branch/branch.entity");
const recommendation_engine_1 = require("./recommendation.engine");
const routing_provider_1 = require("../geo/routing.provider");
const business_rule_entity_1 = require("./business-rule.entity");
describe('PlanningService', () => {
    let service;
    let recommendationEngine;
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
        const module = await testing_1.Test.createTestingModule({
            providers: [
                planning_service_1.PlanningService,
                {
                    provide: (0, typeorm_1.getRepositoryToken)(branch_entity_1.BranchEntity),
                    useValue: mockBranchRepository,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(business_rule_entity_1.BusinessRuleEntity),
                    useValue: mockRuleRepository,
                },
                {
                    provide: recommendation_engine_1.RecommendationEngine,
                    useValue: mockRecommendationEngine,
                },
                {
                    provide: routing_provider_1.RoutingService,
                    useValue: mockRoutingService,
                },
            ],
        }).compile();
        service = module.get(planning_service_1.PlanningService);
        recommendationEngine = module.get(recommendation_engine_1.RecommendationEngine);
        jest.clearAllMocks();
    });
    it('should throw NotFoundException if branch is missing', async () => {
        mockBranchRepository.findOne.mockResolvedValue(null);
        await expect(service.getRecommendedCandidates('missing-id')).rejects.toThrow(common_1.NotFoundException);
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
        await expect(service.updateRule('missing', {}, 'u-1')).rejects.toThrow(common_1.NotFoundException);
    });
});
//# sourceMappingURL=planning.service.spec.js.map