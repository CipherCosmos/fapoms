"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const platform_foundation_module_1 = require("./platform-foundation.module");
const workflow_engine_service_1 = require("./workflow/workflow-engine.service");
const tenant_resolver_service_1 = require("./tenant/tenant-resolver.service");
const platform_audit_service_1 = require("./audit/platform-audit.service");
const typeorm_1 = require("@nestjs/typeorm");
const audit_log_entity_1 = require("./audit/audit-log.entity");
describe('PlatformFoundationModule', () => {
    let moduleRef;
    const mockAuditRepository = {
        create: jest.fn().mockImplementation((arg) => arg),
        save: jest.fn((arg) => Promise.resolve({ id: 'al-1', ...arg })),
    };
    const mockQueueManager = {
        enqueue: jest.fn(),
        registerWorker: jest.fn(),
    };
    beforeEach(async () => {
        moduleRef = await testing_1.Test.createTestingModule({
            imports: [platform_foundation_module_1.PlatformFoundationModule],
        })
            .overrideProvider((0, typeorm_1.getRepositoryToken)(audit_log_entity_1.AuditLogEntity))
            .useValue(mockAuditRepository)
            .overrideProvider('BackgroundQueueManager')
            .useValue(mockQueueManager)
            .compile();
    });
    it('should successfully resolve core infrastructure services', () => {
        const configManager = moduleRef.get('ConfigurationManagerInterface');
        const authzService = moduleRef.get('AuthorizationService');
        const eventDispatcher = moduleRef.get('EventDispatcherInterface');
        const workflowEngine = moduleRef.get(workflow_engine_service_1.ReusableWorkflowEngine);
        const tenantResolver = moduleRef.get(tenant_resolver_service_1.TenantContextResolver);
        const auditService = moduleRef.get(platform_audit_service_1.PlatformAuditService);
        expect(configManager).toBeDefined();
        expect(authzService).toBeDefined();
        expect(eventDispatcher).toBeDefined();
        expect(workflowEngine).toBeDefined();
        expect(tenantResolver).toBeDefined();
        expect(auditService).toBeDefined();
    });
});
//# sourceMappingURL=platform-foundation.module.spec.js.map