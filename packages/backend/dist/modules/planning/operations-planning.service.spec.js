"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const operations_planning_service_1 = require("./operations-planning.service");
const coverage_planning_engine_1 = require("./coverage-planning.engine");
const assignment_service_1 = require("../assignment/assignment.service");
const project_query_service_1 = require("../project/project-query.service");
const coverage_plan_entity_1 = require("./coverage-plan.entity");
const coverage_plan_version_entity_1 = require("./coverage-plan-version.entity");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
describe('OperationsPlanningService', () => {
    let service;
    const mockPlanRepository = {
        findOne: jest.fn(),
        create: jest.fn(),
        save: jest.fn((arg) => Promise.resolve({ id: 'cp-1', ...arg })),
    };
    const mockVersionRepository = {
        create: jest.fn(),
        save: jest.fn((arg) => Promise.resolve({ id: 'v-1', ...arg })),
    };
    const mockPlanningEngine = {
        generateCoveragePlan: jest.fn().mockResolvedValue({
            clusters: [{ id: 'b-1', assignedAssayerName: 'Vijay Shankar', branchCount: 1 }],
        }),
    };
    const mockAssignmentService = {
        create: jest.fn(),
    };
    const mockProjectQueryService = {
        findProjectBranches: jest.fn().mockResolvedValue([
            { id: 'pb-1', branchId: 'b-1' },
        ]),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                operations_planning_service_1.OperationsPlanningService,
                { provide: (0, typeorm_1.getRepositoryToken)(coverage_plan_entity_1.CoveragePlanEntity), useValue: mockPlanRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(coverage_plan_version_entity_1.CoveragePlanVersionEntity), useValue: mockVersionRepository },
                { provide: coverage_planning_engine_1.CoveragePlanningEngine, useValue: mockPlanningEngine },
                { provide: assignment_service_1.AssignmentService, useValue: mockAssignmentService },
                { provide: project_query_service_1.ProjectQueryService, useValue: mockProjectQueryService },
            ],
        }).compile();
        service = module.get(operations_planning_service_1.OperationsPlanningService);
        jest.clearAllMocks();
    });
    it('should create a coverage plan version and allow review status transitions', async () => {
        let callCount = 0;
        mockPlanRepository.findOne.mockImplementation(async () => {
            callCount++;
            if (callCount === 1)
                return null;
            return {
                id: 'cp-1',
                projectId: 'p-1',
                status: coverage_plan_entity_1.CoveragePlanStatus.GENERATED,
                currentVersion: 1,
                versions: [],
            };
        });
        mockPlanRepository.create.mockImplementation((arg) => arg);
        mockVersionRepository.create.mockImplementation((arg) => arg);
        const plan = await service.createOrRegeneratePlan('p-1', [], 'u-1', 'Initial Setup');
        expect(plan.status).toBe(coverage_plan_entity_1.CoveragePlanStatus.GENERATED);
        expect(plan.currentVersion).toBe(1);
    });
    it('should refuse execution of unapproved plans', async () => {
        mockPlanRepository.findOne.mockResolvedValue({
            id: 'cp-1',
            status: coverage_plan_entity_1.CoveragePlanStatus.GENERATED,
            currentVersion: 1,
            versions: [],
        });
        await expect(service.executeApprovedPlan('cp-1', 'u-1')).rejects.toThrow(common_1.BadRequestException);
    });
    it('should execute approved plans and spawn standard operational assignments', async () => {
        const activeVersion = {
            versionNumber: 1,
            planData: {
                clusters: [{ id: 'cluster-b-1', assignedAssayerName: 'Vijay Shankar', branchCount: 1 }],
            },
        };
        mockPlanRepository.findOne.mockResolvedValue({
            id: 'cp-1',
            projectId: 'p-1',
            status: coverage_plan_entity_1.CoveragePlanStatus.APPROVED,
            currentVersion: 1,
            versions: [activeVersion],
        });
        await service.executeApprovedPlan('cp-1', 'u-1');
        expect(mockAssignmentService.create).toHaveBeenCalled();
    });
});
//# sourceMappingURL=operations-planning.service.spec.js.map