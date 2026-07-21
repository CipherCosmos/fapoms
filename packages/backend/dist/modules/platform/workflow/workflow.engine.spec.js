"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const workflow_engine_1 = require("./workflow.engine");
const audit_service_1 = require("../../../core/audit/audit.service");
describe('WorkflowEngine', () => {
    let engine;
    const mockAuditService = {
        recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                workflow_engine_1.WorkflowEngine,
                {
                    provide: audit_service_1.AuditService,
                    useValue: mockAuditService,
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
    it('should fail transition if guards return false', async () => {
        engine.registerWorkflow('assignment', [
            {
                from: ['CREATED'],
                to: 'ACCEPTED',
                guards: [async () => false],
            },
        ]);
        const can = await engine.canTransition('assignment', 'CREATED', 'ACCEPTED', { userId: 'u-1' });
        expect(can).toBe(false);
        await expect(engine.executeTransition('assignment', 'ent-1', 'CREATED', 'ACCEPTED', { userId: 'u-1' })).rejects.toThrow(common_1.BadRequestException);
    });
});
//# sourceMappingURL=workflow.engine.spec.js.map