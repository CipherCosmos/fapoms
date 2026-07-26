"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const project_planning_service_1 = require("./project-planning.service");
const project_query_service_1 = require("../project/project-query.service");
const planning_service_1 = require("./planning.service");
const common_1 = require("@nestjs/common");
describe('ProjectPlanningService', () => {
    let service;
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
                project_planning_service_1.ProjectPlanningService,
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
        service = module.get(project_planning_service_1.ProjectPlanningService);
        jest.clearAllMocks();
    });
    it('should throw NotFoundException if project is missing', async () => {
        mockProjectQueryService.findOne.mockResolvedValue(null);
        await expect(service.getProjectPlanningCandidates('p-missing')).rejects.toThrow(common_1.NotFoundException);
    });
    it('should compile candidates report for unassigned branches', async () => {
        const project = { id: 'p-1', name: 'Project 1', projectNumber: 'P001' };
        mockProjectQueryService.findOne.mockResolvedValue(project);
        mockProjectQueryService.findProjectBranches.mockResolvedValue([
            {
                id: 'pb-1',
                branchId: 'b-1',
                status: 'IMPORTED',
                branch: { branchCode: 'B001', name: 'Branch 1', city: 'Mumbai', state: 'MH' },
            },
            {
                id: 'pb-2',
                branchId: 'b-2',
                status: 'CLOSED',
                branch: { branchCode: 'B002', name: 'Branch 2', city: 'Pune', state: 'MH' },
            },
        ]);
        mockPlanningService.getRecommendedCandidates.mockResolvedValue([
            { id: 'a-1', displayName: 'Vijay Shankar', score: 85 },
        ]);
        const report = await service.getProjectPlanningCandidates('p-1');
        expect(report.projectId).toBe('p-1');
        expect(report.totalUnassignedBranches).toBe(1);
        expect(report.branches).toHaveLength(1);
        expect(report.branches[0].projectBranchId).toBe('pb-1');
        expect(report.branches[0].candidates).toHaveLength(1);
    });
});
//# sourceMappingURL=project-planning.service.spec.js.map