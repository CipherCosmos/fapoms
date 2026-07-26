"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const coverage_planning_engine_1 = require("./coverage-planning.engine");
const project_query_service_1 = require("../project/project-query.service");
const recommendation_engine_1 = require("./recommendation.engine");
const constraint_evaluator_1 = require("./constraint.evaluator");
const cluster_manager_1 = require("./cluster.manager");
describe('CoveragePlanningEngine', () => {
    let engine;
    const mockProjectQueryService = {
        findOne: jest.fn().mockResolvedValue({ id: 'p-1', name: 'Project Alpha', clientId: 'c-1' }),
        findProjectBranches: jest.fn().mockResolvedValue([
            { status: 'IMPORTED', branch: { id: 'b-1', name: 'Branch 1', latitude: 19.0, longitude: 72.0 } },
        ]),
    };
    const mockRecommendationEngine = {
        recommend: jest.fn().mockResolvedValue([
            { assayer: { id: 'a-1', displayName: 'Vijay Shankar' }, score: 90, breakdown: {} },
        ]),
    };
    const mockBranchProvider = {
        getBranchesForPlanning: jest.fn().mockResolvedValue([
            { branchId: { value: 'b-1' }, name: 'Branch 1', location: { latitude: 19.0, longitude: 72.0 }, requiredSkills: { values: ['Gold'] } },
        ]),
    };
    const mockAssayerProvider = {
        getAvailableAssayers: jest.fn().mockResolvedValue([
            { assayerId: { value: 'a-1' }, displayName: 'Vijay Shankar', status: 'ACTIVE', location: { latitude: 19.0, longitude: 72.0 }, skills: { values: ['Gold'] }, maxWeeklyWorkload: 15 },
        ]),
    };
    const mockWorkloadProvider = {
        getAssayerCurrentWorkloads: jest.fn().mockResolvedValue({ 'a-1': 0 }),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                coverage_planning_engine_1.CoveragePlanningEngine,
                cluster_manager_1.ClusterManager,
                { provide: project_query_service_1.ProjectQueryService, useValue: mockProjectQueryService },
                { provide: recommendation_engine_1.RecommendationEngine, useValue: mockRecommendationEngine },
                { provide: constraint_evaluator_1.ConstraintEvaluator, useValue: {} },
                { provide: 'PlanningBranchProvider', useValue: mockBranchProvider },
                { provide: 'AssayerAvailabilityProvider', useValue: mockAssayerProvider },
                { provide: 'WorkloadProvider', useValue: mockWorkloadProvider },
            ],
        }).compile();
        engine = module.get(coverage_planning_engine_1.CoveragePlanningEngine);
        jest.clearAllMocks();
    });
    it('should generate a coverage plan including capacity analysis and confidence metrics', async () => {
        const plan = await engine.generateCoveragePlan('p-1');
        expect(plan.projectId).toBe('p-1');
        expect(plan.coveragePercentage).toBe(100);
        expect(plan.confidenceScore).toBe(100);
        expect(plan.workforceCapacity.length).toBe(1);
        expect(plan.clusters.length).toBe(1);
        expect(plan.clusters[0].assignedAssayerName).toBe('Vijay Shankar');
    });
});
//# sourceMappingURL=coverage-planning.engine.spec.js.map