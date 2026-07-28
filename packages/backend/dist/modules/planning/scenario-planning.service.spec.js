"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const scenario_planning_service_1 = require("./scenario-planning.service");
const project_query_service_1 = require("../project/project-query.service");
const configuration_resolver_1 = require("../platform/configuration/configuration.resolver");
const optimization_engine_1 = require("./optimization.engine");
const recommendation_engine_1 = require("./recommendation.engine");
const client_entity_1 = require("../client/client.entity");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
describe('ScenarioPlanningService', () => {
    let service;
    const mockProjectQueryService = {
        findOne: jest.fn(),
    };
    const mockConfigResolver = {
        resolveRecommendationConfig: jest.fn().mockReturnValue({
            weights: { distance: 0.5 },
            defaultRadius: 50.0,
        }),
    };
    const mockOptimizationEngine = {
        generateProjectDeploymentPlan: jest.fn(),
    };
    const mockClientRepo = {
        findOne: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                scenario_planning_service_1.ScenarioPlanningService,
                {
                    provide: project_query_service_1.ProjectQueryService,
                    useValue: mockProjectQueryService,
                },
                {
                    provide: configuration_resolver_1.ConfigurationResolver,
                    useValue: mockConfigResolver,
                },
                {
                    provide: recommendation_engine_1.RecommendationEngine,
                    useValue: {},
                },
                {
                    provide: optimization_engine_1.OptimizationEngine,
                    useValue: mockOptimizationEngine,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(client_entity_1.ClientEntity),
                    useValue: mockClientRepo,
                },
            ],
        }).compile();
        service = module.get(scenario_planning_service_1.ScenarioPlanningService);
        jest.clearAllMocks();
    });
    it('should throw NotFoundException if project is missing', async () => {
        mockProjectQueryService.findOne.mockResolvedValue(null);
        await expect(service.simulatePlanningScenario({ projectId: 'p-missing' })).rejects.toThrow(common_1.NotFoundException);
    });
    it('should override weights and run simulation successfully', async () => {
        const project = { id: 'p-1', clientId: 'c-1', name: 'Project 1' };
        const client = { id: 'c-1', planningPreferences: { weights: { distance: 0.2 } } };
        mockProjectQueryService.findOne.mockResolvedValue(project);
        mockClientRepo.findOne.mockResolvedValue(client);
        mockOptimizationEngine.generateProjectDeploymentPlan.mockResolvedValue({
            projectId: 'p-1',
            totalBranchesMatched: 1,
            assignments: [],
        });
        const result = await service.simulatePlanningScenario({
            projectId: 'p-1',
            weightOverrides: { distance: 0.8 },
        });
        expect(result.projectId).toBe('p-1');
        expect(mockConfigResolver.resolveRecommendationConfig).toHaveBeenCalled();
        expect(mockOptimizationEngine.generateProjectDeploymentPlan).toHaveBeenCalledWith('p-1');
    });
});
//# sourceMappingURL=scenario-planning.service.spec.js.map