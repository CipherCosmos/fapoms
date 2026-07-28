import { Test, TestingModule } from '@nestjs/testing';
import { PlatformFoundationModule } from './platform-foundation.module';
import { ConfigurationManagerInterface } from './configuration/configuration-manager.interface';
import { AuthorizationService } from './authz/authorization.interface';
import { EventDispatcherInterface } from './events/event-dispatcher.interface';
import { ReusableWorkflowEngine } from './workflow/workflow-engine.service';
import { TenantContextResolver } from './tenant/tenant-resolver.service';
import { PlatformAuditService } from './audit/platform-audit.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditLogEntity } from './audit/audit-log.entity';
import { BackgroundQueueManager } from './background/queue-manager.interface';

describe('PlatformFoundationModule', () => {
  let moduleRef: TestingModule;

  const mockAuditRepository = {
    create: jest.fn().mockImplementation((arg) => arg),
    save: jest.fn((arg) => Promise.resolve({ id: 'al-1', ...arg })),
  };

  const mockQueueManager: BackgroundQueueManager = {
    enqueue: jest.fn(),
    registerWorker: jest.fn(),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PlatformFoundationModule],
    })
      .overrideProvider(getRepositoryToken(AuditLogEntity))
      .useValue(mockAuditRepository)
      .overrideProvider('BackgroundQueueManager')
      .useValue(mockQueueManager)
      .compile();
  });

  it('should successfully resolve core infrastructure services', () => {
    const configManager = moduleRef.get<ConfigurationManagerInterface>('ConfigurationManagerInterface');
    const authzService = moduleRef.get<AuthorizationService>('AuthorizationService');
    const eventDispatcher = moduleRef.get<EventDispatcherInterface>('EventDispatcherInterface');
    const workflowEngine = moduleRef.get<ReusableWorkflowEngine>(ReusableWorkflowEngine);
    const tenantResolver = moduleRef.get<TenantContextResolver>(TenantContextResolver);
    const auditService = moduleRef.get<PlatformAuditService>(PlatformAuditService);

    expect(configManager).toBeDefined();
    expect(authzService).toBeDefined();
    expect(eventDispatcher).toBeDefined();
    expect(workflowEngine).toBeDefined();
    expect(tenantResolver).toBeDefined();
    expect(auditService).toBeDefined();
  });
});
