"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const optimization_engine_1 = require("./optimization.engine");
const project_query_service_1 = require("../project/project-query.service");
const planning_service_1 = require("./planning.service");
const common_1 = require("@nestjs/common");
describe('OptimizationEngine', () => {
    let engine;
    const mockProjectQueryService = {
        findOne: jest.fn(),
        findProjectBranches: jest.fn(),
    };
    const mockPlanningService = {
        getRecommendedCandidates: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                optimization_engine_1.OptimizationEngine,
                {
                    provide: project_query_service_1.ProjectQueryService,
                    useValue: mockProjectQueryService,
                },
                {
                    provide: planning_service_1.PlanningService,
                    useValue: mockPlanningService,
                },
            ],
        }).compile();
        engine = module.get(optimization_engine_1.OptimizationEngine);
        jest.clearAllMocks();
    });
    it('should throw NotFoundException if project is missing', async () => {
        mockProjectQueryService.findOne.mockResolvedValue(null);
        await expect(engine.generateProjectDeploymentPlan('p-missing')).rejects.toThrow(common_1.NotFoundException);
    });
    it('should solve deployment plan using greedy selection', async () => {
        const project = { id: 'p-1', name: 'Project 1' };
        mockProjectQueryService.findOne.mockResolvedValue(project);
        mockProjectQueryService.findProjectBranches.mockResolvedValue([
            {
                id: 'pb-1',
                branchId: 'b-1',
                status: 'IMPORTED',
                branch: { name: 'Branch Mumbai' },
            },
        ]);
        mockPlanningService.getRecommendedCandidates.mockResolvedValue([
            { id: 'a-1', displayName: 'Vijay Shankar', score: 85 },
            { id: 'a-2', displayName: 'Karthik Raja', score: 70 },
        ]);
        const plan = await engine.generateProjectDeploymentPlan('p-1');
        expect(plan.projectId).toBe('p-1');
        expect(plan.totalBranchesMatched).toBe(1);
        expect(plan.assignments).toHaveLength(1);
        expect(plan.assignments[0].assignedAssayerId).toBe('a-1');
    });
});
//# sourceMappingURL=optimization.engine.spec.js.map