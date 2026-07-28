"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const operations_execution_service_1 = require("./operations-execution.service");
const operations_execution_group_entity_1 = require("./operations-execution-group.entity");
const operations_execution_conversation_entity_1 = require("./operations-execution-conversation.entity");
const assignment_entity_1 = require("../assignment/assignment.entity");
const typeorm_1 = require("@nestjs/typeorm");
describe('OperationsExecutionService', () => {
    let service;
    const mockGroupRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 'eg-1', ...arg })),
        findOne: jest.fn(),
    };
    const mockConversationRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 'ec-1', ...arg })),
    };
    const mockAssignmentRepository = {
        update: jest.fn(),
        findOne: jest.fn(),
        save: jest.fn(),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                operations_execution_service_1.OperationsExecutionService,
                { provide: (0, typeorm_1.getRepositoryToken)(operations_execution_group_entity_1.OperationsExecutionGroupEntity), useValue: mockGroupRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(operations_execution_conversation_entity_1.OperationsExecutionConversationEntity), useValue: mockConversationRepository },
                { provide: (0, typeorm_1.getRepositoryToken)(assignment_entity_1.AssignmentEntity), useValue: mockAssignmentRepository },
            ],
        }).compile();
        service = module.get(operations_execution_service_1.OperationsExecutionService);
        jest.clearAllMocks();
    });
    it('should package multiple assignments into a single route package', async () => {
        const mockAssignment = { id: 'a-1', executionGroupId: null };
        mockAssignmentRepository.findOne.mockResolvedValue(mockAssignment);
        mockGroupRepository.findOne.mockResolvedValue({ id: 'eg-1', status: operations_execution_group_entity_1.ExecutionGroupStatus.DRAFT, assignments: [mockAssignment] });
        const pkg = await service.packageAssignments({
            assayerId: 'as-1',
            name: 'Mumbai Route Package',
            assignmentIds: ['a-1'],
        });
        expect(pkg.id).toBe('eg-1');
        expect(pkg.assignments).toHaveLength(1);
    });
    it('should post conversation history messages and transition status flags', async () => {
        const mockGroup = { id: 'eg-1', status: operations_execution_group_entity_1.ExecutionGroupStatus.DRAFT };
        mockGroupRepository.findOne.mockResolvedValue(mockGroup);
        const msg = await service.postConversationMessage('eg-1', operations_execution_conversation_entity_1.NegotiationParticipant.ASSAYER, 'Need higher allowance', 1800);
        expect(msg.proposedFeeOverride).toBe(1800);
    });
    it('should check audit operational readiness metrics', async () => {
        const mockGroup = { id: 'eg-1', status: operations_execution_group_entity_1.ExecutionGroupStatus.CONFIRMED, totalFee: 1500, assignments: [{ id: 'a-1' }] };
        mockGroupRepository.findOne.mockResolvedValue(mockGroup);
        const readiness = await service.evaluateOperationalReadiness('eg-1');
        expect(readiness.isReady).toBe(true);
    });
});
//# sourceMappingURL=operations-execution.service.spec.js.map