"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const workflow_engine_1 = require("./workflow.engine");
const workflow_history_entity_1 = require("./workflow-history.entity");
const audit_service_1 = require("../../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
describe('WorkflowEngine', () => {
    let engine;
    const mockAuditService = {
        recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    const mockHistoryRepository = {
        create: jest.fn().mockImplementation((dto) => dto),
        save: jest.fn().mockResolvedValue(undefined),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                workflow_engine_1.WorkflowEngine,
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(workflow_history_entity_1.WorkflowHistoryEntity),
                    useValue: mockHistoryRepository,
                },
            ],
        }).compile();
        engine = module.get(workflow_engine_1.WorkflowEngine);
        jest.clearAllMocks();
    });
    it('should register and execute a workflow transition successfully', async () => {
        const hook = jest.fn();
        engine.registerWorkflow('assignment', [
            {
                from: ['CREATED'],
                to: 'ACCEPTED',
                guards: [async () => true],
                afterTransition: async () => {
                    hook();
                },
            },
        ]);
        const can = await engine.canTransition('assignment', 'CREATED', 'ACCEPTED', { userId: 'u-1' });
        expect(can).toBe(true);
        await engine.executeTransition('assignment', 'ent-1', 'CREATED', 'ACCEPTED', { userId: 'u-1' });
        expect(hook).toHaveBeenCalled();
        expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });
    it('should execute command and verify role authorization', async () => {
        engine.registerWorkflow('assignment', [
            {
                from: ['CREATED'],
                to: 'ACCEPTED',
                guards: [async () => true],
            },
        ]);
        const action = jest.fn().mockResolvedValue('success');
        const res = await engine.executeCommand('assignment', 'ent-1', 'AcceptCommand', 'CREATED', 'ACCEPTED', 'u-1', shared_1.SystemRole.SUPER_ADMINISTRATOR, [shared_1.SystemRole.SUPER_ADMINISTRATOR], action);
        expect(res).toBe('success');
        expect(action).toHaveBeenCalled();
        expect(mockHistoryRepository.save).toHaveBeenCalled();
    });
    it('should throw BadRequestException if user role is not authorized', async () => {
        engine.registerWorkflow('assignment', [
            {
                from: ['CREATED'],
                to: 'ACCEPTED',
                guards: [async () => true],
            },
        ]);
        const action = jest.fn();
        await expect(engine.executeCommand('assignment', 'ent-1', 'AcceptCommand', 'CREATED', 'ACCEPTED', 'u-1', 'PLANNER', [shared_1.SystemRole.SUPER_ADMINISTRATOR], action)).rejects.toThrow(common_1.BadRequestException);
    });
});
//# sourceMappingURL=workflow.engine.spec.js.map