"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const operations_control_center_service_1 = require("./operations-control-center.service");
const operations_task_entity_1 = require("./operations-task.entity");
const operations_exception_entity_1 = require("./operations-exception.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const typeorm_1 = require("@nestjs/typeorm");
describe('OperationsControlCenterService', () => {
    let service;
    const mockTaskRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 't-1', ...arg })),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn(),
    };
    const mockExceptionRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 'e-1', ...arg })),
        findOne: jest.fn(),
    };
    const mockAssignmentRepo = {
        find: jest.fn().mockResolvedValue([]),
    };
    const mockProjectMetricsProvider = {
        getTotalProjectsCount: jest.fn().mockResolvedValue(0),
        getActiveProjectsCount: jest.fn().mockResolvedValue(0),
        getProjectsAtRiskCount: jest.fn().mockResolvedValue(0),
        getProjectBranchCounts: jest.fn().mockResolvedValue({ total: 0, deployed: 0 }),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                operations_control_center_service_1.OperationsControlCenterService,
                { provide: (0, typeorm_1.getRepositoryToken)(operations_task_entity_1.OperationsTaskEntity), useValue: mockTaskRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(operations_exception_entity_1.OperationsExceptionEntity), useValue: mockExceptionRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepo },
                { provide: 'ProjectMetricsProvider', useValue: mockProjectMetricsProvider },
            ],
        }).compile();
        service = module.get(operations_control_center_service_1.OperationsControlCenterService);
        jest.clearAllMocks();
    });
    it('should compile operational dashboard KPI parameters successfully', async () => {
        const summary = await service.getDashboardSummary();
        expect(summary.totalProjects).toBe(0);
        expect(summary.overallCoveragePercentage).toBe(0);
    });
    it('should create and resolve tasks in the queue', async () => {
        const task = await service.createOperationsTask('p-1', 'No Response', 'Assayer call pending', operations_task_entity_1.OperationsTaskPriority.HIGH);
        expect(task.title).toBe('No Response');
        mockTaskRepository.findOne.mockResolvedValue(task);
        const resolved = await service.resolveOperationsTask('t-1', 'Assayer responded');
        expect(resolved.status).toBe(operations_task_entity_1.OperationsTaskStatus.RESOLVED);
    });
    it('should manage custom exceptions and allow bypass resolution', async () => {
        const exc = await service.flagException('p-1', operations_exception_entity_1.OperationsExceptionCategory.CAPACITY_EXCEEDED, 'Workload limit reached');
        expect(exc.category).toBe(operations_exception_entity_1.OperationsExceptionCategory.CAPACITY_EXCEEDED);
        mockExceptionRepository.findOne.mockResolvedValue(exc);
        const resolved = await service.resolveException('e-1', 'Approved temporary capacity waiver');
        expect(resolved.status).toBe(operations_exception_entity_1.OperationsExceptionStatus.RESOLVED);
    });
});
//# sourceMappingURL=operations-control-center.service.spec.js.map